/**
 * Independent review of client step 11b (feat/account-list-client-join at 4de8b53ef): the sequence behind each
 * finding, failing on that head, and the guards checked and found to hold, passing. Taken into the suite with the
 * fixes: F1's second test makes its card through the page as the shell does, and the carrier answers the relay's own
 * keepalive as the relay does.
 */
import { afterEach, describe, expect, it, jest } from "bun:test";
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG } from "../../../relay/core.ts";
import { entryFromText, entryHash } from "../../../shared/account-list-entry.ts";
import { bounded } from "../../../server/relay/test-helpers.ts";
import { LIST_JOIN_PLACING_MS, ListMismatchError } from "../../../shared/relay-channel.ts";
import { exportPublicKey, generateKeyPair, openDaemonSecureChannel, type SecureChannel, type Transport } from "../../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, decodeFrame, encodeFrame, FrameType, LIMITS_V1, MuxProtocolError, type MuxFrame } from "../../../shared/relay-mux.ts";
import { PAIR_APPROVAL_MS } from "../../../shared/relay-pair-sas.ts";
import { deriveServerId } from "../../../shared/relay-server-proof.ts";
import type { AccountList, AccountListView } from "../account/accountList.ts";
import { listWorld, type WorldDevice } from "../account/accountList.test-helpers.ts";
import { approveForAccount, ListAllowError, NotConfirmedError, type PcFetch } from "../account/join.ts";
import { allowDevice } from "../account/listAllow.ts";
import { deviceCard, deviceListKeys } from "../account/listKeys.ts";
import { memoryAccountStore, newKey, type AccountSession, type AccountStore } from "../account/store.ts";
import { createAccountController } from "./accountController.ts";
import { openRelayChannel, type RelaySocket } from "./channel.ts";
import type { RelayDevice, RelayDeviceStore, ShellDeviceStore } from "./device.ts";

const ends: (() => void)[] = [];
afterEach(() => { for (const end of ends.splice(0).reverse()) end(); jest.useRealTimers(); });

// ---------------------------------------------------------------------------------------------------------------------
// Harness: the new device's page (its controller over its own store and copy of the list), a scripted PC for the
// app's channel, and a member's approval against PC X (as admitWithList.test.ts).
// ---------------------------------------------------------------------------------------------------------------------

/** The globals the controller reads (shell.test.tsx createShellTestPage, without importing that test file). */
function testPage(): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ["window", "document", "navigator", "localStorage", "sessionStorage", "matchMedia"]) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  const storage = () => { const kept = new Map<string, string>(); return { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => { kept.set(key, value); }, removeItem: (key: string) => { kept.delete(key); }, key: () => null, length: 0, clear: () => kept.clear() }; };
  const matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const events = new EventTarget();
  const page = new EventTarget();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en"], userAgent: "Mozilla/5.0 (X11; Linux x86_64)", maxTouchPoints: 0 } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage() });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage() });
  Object.defineProperty(globalThis, "matchMedia", { configurable: true, value: matchMedia });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { href: "https://app.ovis.sh/", search: "", hash: "", origin: "https://app.ovis.sh", pathname: "/" }, history: { state: null, replaceState() {} }, matchMedia, innerWidth: 1440,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), dispatchEvent: events.dispatchEvent.bind(events),
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {}, removeProperty() {} } }, querySelector: () => null,
    addEventListener: page.addEventListener.bind(page), removeEventListener: page.removeEventListener.bind(page), dispatchEvent: page.dispatchEvent.bind(page),
  } });
  return () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } };
}

const noPairings: ShellDeviceStore = {
  get: async () => undefined, list: async () => [], remove: async () => {}, removeRow: async () => false,
  update: async () => { throw new Error("No pairing is made here"); },
};

/** The new device's page as shell.tsx drives it: its controller over its own store and its own copy of the list. */
function pageOf(world: ReturnType<typeof listWorld>, device: WorldDevice) {
  ends.push(testPage());
  const controller = createAccountController({
    container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: noPairings, accountStore: device.store, accountService: world.origin,
    accountFetch: async (input, init) => world.fake.fetch(new Request(input, init)),
    renderApp: () => ({ render() {}, unmount() {} }), accountList: device.list,
  }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
  ends.push(() => controller.dispose());
  return controller;
}

/** Another tab of the same browser signs in to `account`: the store all tabs share holds that sign-in from now on. */
async function signInElsewhere(world: ReturnType<typeof listWorld>, device: WorldDevice, account: string): Promise<AccountSession> {
  const session: AccountSession = {
    service: world.origin, account, provider: "github", access_token: world.fake.issueToken(account), refresh_token: `refresh-${account}`,
    expires_at: world.clock.now + 86_400_000, sign_in_id: `sign-in-${account}-${Math.random()}`, signed_in_at: world.clock.now,
  };
  const key = await newKey();
  await device.store.set("session", session);
  await device.store.set("signin_key", { account, sign_in_id: session.sign_in_id!, key, no: world.fake.registerSessionKey(session.access_token, key.public_spki, "Tablet") });
  return session;
}

/**
 * The new device waits to be let into account A's list (not_in, its claim standing) and joins a PC pinned to it with
 * its card; a member's entry lets it in, and the PC's AUTH_OK names that place (case 1). Answers the place.
 */
async function letInByCase1() {
  // the page's controller reads the sign-in by the real clock: the world runs on it too
  const w = listWorld("acct_a", Date.now());
  w.fake.listAccounts = "*";
  const member = await w.device({ label: "Phone" });
  await member.list.sync();
  const newcomer = await w.device({ label: "Tablet", genesis: "never" });
  expect((await newcomer.list.sync()).status).toMatchObject({ at: "not_in", why: "not_mine", claim: "claimed" });
  const allowed = await allowDevice(member.list, { key: (await newcomer.keys()).key, label: "Tablet", os: "android" }, { account: w.account });
  if (!allowed.allowed) throw new Error(`The member could not let the device in: ${allowed.why}`);
  return { w, member, newcomer, place: { id: allowed.offer.list, seq: allowed.offer.seq, hash: allowed.offer.hash } };
}

/** The carrier between the app's channel and a scripted PC: what one sends, the other hears; the app's sends are kept. */
class Carrier implements RelaySocket {
  binaryType: BinaryType = "arraybuffer";
  onmessage: RelaySocket["onmessage"] = null;
  onclose: RelaySocket["onclose"] = null;
  onerror: RelaySocket["onerror"] = null;
  closed = false;
  /** every frame the app put on its relay socket, in order */
  readonly sent: (string | ArrayBuffer)[] = [];
  get readyState(): number { return this.closed ? 3 : 1; }
  constructor(readonly daemon: Transport) {}
  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (this.closed) throw new Error("Socket closed");
    if (typeof data !== "string" && !(data instanceof ArrayBuffer)) throw new Error("Unexpected carrier type");
    this.sent.push(data);
    // the relay answers its own keepalive (relay/core.ts KEEPALIVE_PING), and the PC never sees it
    if (data === KEEPALIVE_PING) { queueMicrotask(() => this.deliver(KEEPALIVE_PONG)); return; }
    this.daemon.onmessage?.({ data, isBinary: typeof data !== "string" });
  }
  deliver(data: string | ArrayBuffer): void { if (!this.closed) this.onmessage?.(new MessageEvent("message", { data })); }
  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.daemon.onclose?.(code, reason);
    this.onclose?.(new CloseEvent("close", { code, reason }));
  }
}

const base64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/**
 * A PC as the app's channel meets it (server/relay/session.ts): it selects what it is given of `features`, names
 * `list` in its challenge, and after PAIR_CONFIRM answers AUTH_OK with `ok` (with `ok` null: nothing until `answer`).
 */
function scriptedPc(pc: { features: readonly string[]; list?: string; ok?: Record<string, unknown> | null }) {
  const keys = generateKeyPair();
  let socket: Carrier;
  const daemon: Transport = {
    onmessage: null, onclose: null, onerror: null,
    send: (data) => socket.deliver(data),
    close: (code, reason) => { setImmediate(() => socket.close(code, reason)); },
  };
  socket = new Carrier(daemon);
  const ready = Promise.withResolvers<SecureChannel>();
  const send = (frame: MuxFrame) => ready.promise.then((channel) => channel.send(encodeFrame(frame).slice().buffer));
  const request = Promise.withResolvers<Record<string, unknown>>();
  const confirmed = Promise.withResolvers<number>();
  const authOk = (extra: Record<string, unknown>) => send({ type: FrameType.AUTH_OK, flags: 0, stream_id: 0, payload: { session_id: "ab".repeat(16), device_id: "cd".repeat(8), role: "drive", ...extra } as never });
  void openDaemonSecureChannel(daemon, { daemonKeyPair: keys, events: { onmessage: (data) => {
    const frame = decodeFrame(new Uint8Array(data as ArrayBuffer));
    if (frame.type === FrameType.HELLO) void send({ type: FrameType.WELCOME, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", version: 1,
      features: pc.features.filter((feature) => frame.payload.features.includes(feature)), limits: LIMITS_V1, nonce: base64url(new Uint8Array(32)), server_version: "0.4.21", relay_protocol: 1, min_supported_client: "0.4.20" } });
    if (frame.type === FrameType.PAIR_REQUEST) {
      request.resolve(frame.payload as unknown as Record<string, unknown>);
      void send({ type: FrameType.PAIR_CHALLENGE, flags: 0, stream_id: 0, payload: { nonce: base64url(new Uint8Array(32).fill(7)), ...(pc.list === undefined ? {} : { list: pc.list }) } });
    }
    if (frame.type === FrameType.PAIR_CONFIRM) {
      confirmed.resolve(socket.sent.length);
      if (pc.ok !== null) void authOk(pc.ok ?? {});
    }
  } } }).then((channel) => ready.resolve(channel), () => {});
  const offer = { v: 1 as const, server_id: "12".repeat(16), server_public_key: exportPublicKey(keys.publicKey), relay: "wss://relay.example" };
  ends.push(() => socket.close());
  return { socket, offer, request: bounded(request.promise), confirmed: confirmed.promise, answer: authOk };
}

/** A device store in memory (device.test.ts MemoryDeviceStore, without importing that test file). */
function memoryDevices(): RelayDeviceStore & { rows: Map<string, RelayDevice> } {
  const rows = new Map<string, RelayDevice>();
  return {
    rows,
    get: async (id: string) => rows.get(id), list: async () => [...rows.values()],
    update: async (id: string, change: (current: RelayDevice | undefined) => RelayDevice) => { const next = change(rows.get(id)); rows.set(id, next); return next; },
    remove: async (id: string) => { rows.delete(id); },
  } as unknown as RelayDeviceStore & { rows: Map<string, RelayDevice> };
}

/** The new device's account key and its card for `list`. */
async function cardFor(list: string) {
  const accounts = memoryAccountStore();
  const keys = await deviceListKeys(accounts);
  return { key: await accounts.key(), listCard: { list, enc: keys.enc.key, card: (await deviceCard(keys, list)).card } };
}

/** The app's channel for a join of the account against `pc`; `told`: what each compare call was told about the list. */
function join(pc: ReturnType<typeof scriptedPc>, options: { key: Awaited<ReturnType<typeof cardFor>>["key"]; listCard?: Awaited<ReturnType<typeof cardFor>>["listCard"] }) {
  const store = memoryDevices();
  const told: (true | undefined)[] = [];
  const opening = openRelayChannel(pc.offer, { store, intent: "account", accountKey: options.key, ...(options.listCard === undefined ? {} : { listCard: options.listCard }),
    compare: async (_digits, _approveOn, intoList) => { told.push(intoList); },
    socket: () => { queueMicrotask(() => pc.socket.deliver(JSON.stringify({ type: "assigned", connection_id: "ab".repeat(16) }))); return pc.socket; } });
  void opening.catch(() => {});
  return { opening, store, told };
}

/** PC X as an approval meets it (admitWithList.test.ts pcX): it records what it is sent and answers each call as told. */
function pcX(answers: { head?: (body: unknown) => Response; page?: (body: unknown) => Response | Promise<Response>; introduce?: (body: Record<string, unknown>) => Response | Promise<Response> } = {}) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: PcFetch = async (path, init) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    sent.push({ path, body });
    if (path === "/api/account/list/head") return answers.head?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/list/page") return answers.page?.(body) ?? Response.json({ error: { code: "not_found" } }, { status: 404 });
    if (path === "/api/account/introduce" && answers.introduce !== undefined) return answers.introduce(body);
    return new Response(null, { status: 204 });
  };
  return { sent, fetch, paths: () => sent.map((each) => each.path) };
}

const noWait = async (): Promise<void> => {};
/** A pause that moves the world's clock by its length: a poll bounded by a deadline (the introduction's) ends instead of spinning. */
const passes = (w: { clock: { now: number } }) => async (ms: number): Promise<void> => { w.clock.now += ms; };

/** A member of an account with a list, a new device that rang at PC X, and one press of Approve on its card (admitWithList.test.ts rang). */
async function rang() {
  const w = listWorld();
  const member = await w.device({ label: "Phone" });
  await member.list.sync();
  const newcomer = await w.device({ label: "Tablet" });
  await newcomer.list.sync();
  const relay = generateKeyPair().publicKey;
  const X = deriveServerId(relay);
  await member.service.putPc(X, { label: "Desk", public_key: Array.from(relay, (byte) => byte.toString(16).padStart(2, "0")).join(""), relay: "wss://relay.test" });
  const key = (await newcomer.keys()).key;
  await newcomer.service.postAdmission(X, "Tablet", key, "android");
  const request = { id: "r1", label: "Tablet", intent: "account" as const, choices: ["111111", "222222", "333333"] as [string, string, string], expires_at: "", key };
  const said: (string | null)[] = [];
  const ways: boolean[] = [];
  const order: string[] = [];
  const approve = (pc: ReturnType<typeof pcX>, followsList: boolean, told: { list?: true; confirmed?: true } = {}, list: AccountList | null = member.list, onDecide?: () => void) => approveForAccount({
    request: { ...request, ...told }, digits: "222222", through: X, service: member.service, account: w.account, key: member.store.key(), list,
    pc: { fetch: async (path, init) => { order.push(path); return pc.fetch(path, init); }, followsList },
    decide: async (decision) => { order.push(decision); onDecide?.(); }, paired: async () => [], directory: async () => [X], wait: passes(w), now: () => w.clock.now,
    onStalled: (stalled) => { said.push(stalled === null ? null : stalled.why); if (stalled !== null) ways.push(stalled.pairedAtPc); },
  });
  return { w, member, X, key, order, said, ways, approve };
}

/** A PC that lets devices in by the list, as an approval meets it (admitWithList.test.ts pinnedPc): it takes the page and keeps no row a member added. */
function pinnedX(w: ReturnType<typeof listWorld>, onPage?: () => void) {
  const list = w.held();
  return pcX({
    head: () => Response.json({ list: list.id, place: { seq: 0, hash: list.id } }),
    page: () => { onPage?.(); return Response.json({ verdict: "caught_up", list: list.id, place: w.held().head }); },
    introduce: () => Response.json({ error: { code: "account_required", message: "x" } }, { status: 403 }),
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Findings: each fails on 4de8b53ef.
// ---------------------------------------------------------------------------------------------------------------------

describe("F1 (MEDIUM): the place AUTH_OK.list hands over is taken for whichever account is signed in when it lands", () => {
  it("writes nothing of account A's list under account B, whose sign-in another tab stored while the join waited", async () => {
    const { w, newcomer, place } = await letInByCase1();
    // the join waited up to three minutes for its approval: meanwhile another tab signed out of A and in to B
    await signInElsewhere(w, newcomer, "acct_b");
    const page = pageOf(w, newcomer);
    // shell.tsx, once the PC let the device in and named its place (accountController.ts takePlace)
    await page.takePlace(place);
    const kept = await newcomer.lists.get("offer", "acct_b");
    // and every later round of account B on this device asks for account A's log under B's sign-in (404), for good
    newcomer.sent.length = 0;
    await newcomer.list.sync().catch(() => null);
    const asksForA = newcomer.sent.filter((each) => each.route.includes(place.id)).map((each) => each.route);
    expect({ kept, asksForA }).toEqual({ kept: undefined, asksForA: [] });
  });

  it("keeps the place for account A: the device follows A's list once A is signed in again, which it has no other way to learn", async () => {
    const { w, member, newcomer, place } = await letInByCase1();
    const a = (await newcomer.store.get("session"))!;
    const page = pageOf(w, newcomer);
    // the join, as shell.tsx prepares it under A: its card is made for A's list (accountController.ts prepare, cardFor)
    const relay = generateKeyPair().publicKey;
    const X = deriveServerId(relay);
    await member.service.putPc(X, { label: "Desk", public_key: Buffer.from(relay).toString("hex"), relay: "wss://relay.test" });
    const offer = { v: 1 as const, server_id: X, server_public_key: exportPublicKey(relay), relay: "wss://relay.test" };
    expect((await page.prepare(offer, new AbortController().signal)).listCard).toMatchObject({ list: place.id });
    await signInElsewhere(w, newcomer, "acct_b");
    expect(await page.takePlace(place)).toBe(false);
    // the person signs in to A again: A's list holds this device
    await newcomer.store.set("session", a);
    const view = await newcomer.list.sync().catch(() => null);
    expect(view?.status).toMatchObject({ at: "following", standing: "in" });
  });
});

describe("F2 (MEDIUM): a join that brought its card waits past the relay's idle limit with a silent socket", () => {
  it("keeps its relay socket from going idle while it waits for the PC's entry after its person pressed The numbers match", async () => {
    jest.useFakeTimers();
    const LIST = "5c".repeat(32);
    const { key, listCard } = await cardFor(LIST);
    const pc = scriptedPc({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, ok: null });
    const { opening } = join(pc, { key, listCard });
    let ended: unknown = null;
    void opening.then(() => { ended = "joined"; }, (error: unknown) => { ended = error; });
    // the person pressed at once; a member approves late in the comparison's window, and the PC then waits for the
    // entry (its own window's signing, or the member's half minute and its last read): AUTH_OK is still to come
    const atConfirm = await bounded(pc.confirmed);
    const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
    jest.advanceTimersByTime(IDLE_MS);
    await settle();
    // relay/core.ts sweep: a socket that sent no frame (nor keepalive) for IDLE_MS is closed GOING_AWAY "idle", whatever
    // the PC sent it (relay/worker.test.ts "an alarm closes sockets idle for 120 s"). The app still waits here: its own
    // deadline for this join is PAIR_APPROVAL_MS + 5 s + LIST_JOIN_PLACING_MS
    expect(PAIR_APPROVAL_MS + 5_000 + LIST_JOIN_PLACING_MS).toBeGreaterThan(IDLE_MS);
    const sentSince = pc.socket.sent.length - atConfirm;
    expect({ stillWaiting: ended === null, keptAlive: sentSince > 0 }).toEqual({ stillWaiting: true, keptAlive: true });
  });
});

describe("F3 (LOW): on a PC that follows no list, the approval is bound to its member key only from its first write", () => {
  it("signs nothing under another member key that this device took while the approval waited for the PC's row", async () => {
    const { w, member, key, said, approve } = await rang();
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    // a second full member of the same list (as admitWithList.test.ts's Try again test makes one)
    const other = await w.device({ label: "Laptop" });
    await other.list.sync();
    const laptop = (await other.keys()).key;
    const allowed = await allowDevice(member.list, { key: laptop, label: "Laptop", os: null }, { wait: noWait });
    if (!allowed.allowed) throw new Error(`The laptop was not let in: ${allowed.why}`);
    await other.list.adopt(allowed.offer);
    // case 2: the approval waits until X holds the new device's row; meanwhile another tab puts the laptop's key on this
    // device, and the page's list writes with it from then on
    let asked = 0;
    const pc = pcX({ introduce: async () => {
      asked += 1;
      if (asked > 1) return new Response(null, { status: 204 });
      current = other.list;
      return Response.json({ error: { code: "introduction_unknown_key", message: "x" } }, { status: 404 });
    } });
    await approve(pc, false, {}, page);
    // the approval began under this device's own member key: no entry for the new device is signed by another
    const row = w.held().state.signers[key];
    expect({ by: row === undefined ? null : row.by === laptop ? "laptop" : "own", said }).toEqual({ by: null, said: ["changed"] });
  });
});

describe("F4 (LOW): on a PC that follows the list, the member's introduction carries no `list`", () => {
  it("names the new device's place in the introduction in case 1 too (formats Part E6: a member sends list in introduce in both cases)", async () => {
    const { w, key, approve } = await rang();
    const pc = pinnedX(w);
    await approve(pc, true, { list: true, confirmed: true });
    const row = w.held().state.signers[key];
    expect(row).toBeDefined();
    const introduced = pc.sent.filter((each) => each.path === "/api/account/introduce").map((each) => each.body.list ?? null);
    expect(introduced).toEqual([{ id: w.held().id, seq: row!.seq, hash: entryHash(entryFromText(w.held().entries[row!.seq]!).body) }]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Guards checked and found to hold: each passes on 4de8b53ef.
// ---------------------------------------------------------------------------------------------------------------------

describe("held: the new device's channel", () => {
  const LIST = "5c".repeat(32);
  const OTHER = "6d".repeat(32);

  it("G1: a PC that took the card and lets the device in naming no place is refused, and nothing is saved", async () => {
    const { key, listCard } = await cardFor(LIST);
    const pc = scriptedPc({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, ok: {} });
    const { opening, store } = join(pc, { key, listCard });
    const error = await bounded(opening.then(() => null, (reason: unknown) => reason));
    expect(error instanceof MuxProtocolError && [error.code, error.message]).toEqual(["auth_failed", "list_refused"]);
    expect(store.rows.size).toBe(0);
  });

  it("G2: a PC whose challenge names another list ends the join before any digits reach the person", async () => {
    const { key, listCard } = await cardFor(LIST);
    const pc = scriptedPc({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: OTHER, ok: {} });
    const { opening, told } = join(pc, { key, listCard });
    expect(await bounded(opening.then(() => null, (reason: unknown) => reason))).toBeInstanceOf(ListMismatchError);
    expect(told).toEqual([]);
  });

  it("G3: a place in another list than the card's is not taken, and nothing is saved", async () => {
    const { key, listCard } = await cardFor(LIST);
    const pc = scriptedPc({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, ok: { list: { id: OTHER, seq: 3, hash: "ab".repeat(32) } } });
    const { opening, store } = join(pc, { key, listCard });
    expect(await bounded(opening.then(() => null, (reason: unknown) => reason))).toBeInstanceOf(ListMismatchError);
    expect(store.rows.size).toBe(0);
  });

  it("G4: a PC that does not select the feature is sent no card, its place is not taken, and the pairing is saved as before", async () => {
    const { key, listCard } = await cardFor(LIST);
    const pc = scriptedPc({ features: ["pair-sas"], ok: { list: { id: LIST, seq: 3, hash: "ab".repeat(32) } } });
    const { opening, store, told } = join(pc, { key, listCard });
    const channel = await bounded(opening);
    ends.push(() => channel.close());
    expect(Object.keys(await pc.request).filter((name) => name.startsWith("list_"))).toEqual([]);
    expect([channel.listPlace, store.rows.size, told]).toEqual([undefined, 1, [undefined]]);
  });

  it("G5: the comparison of a join the PC took the card for is told so, and the place is handed over with no pairing saved", async () => {
    const { key, listCard } = await cardFor(LIST);
    const place = { id: LIST, seq: 3, hash: "ab".repeat(32) };
    const pc = scriptedPc({ features: ["pair-sas", ACCOUNT_LIST_ALLOW], list: LIST, ok: { list: place } });
    const { opening, store, told } = join(pc, { key, listCard });
    const channel = await bounded(opening);
    ends.push(() => channel.close());
    expect(await pc.request).toMatchObject({ list_enc: listCard.enc, list_card: listCard.card });
    expect([channel.listPlace, store.rows.size, told]).toEqual([place, 0, [true]]);
  });
});

describe("held: the member's approval on a PC that follows the list", () => {
  it("G6: approves nothing and signs nothing before the PC says the new device confirmed", async () => {
    const { w, key, order, approve } = await rang();
    const entries = w.held().entries.length;
    expect(await approve(pinnedX(w), true, { list: true }).catch((error: unknown) => error)).toBeInstanceOf(NotConfirmedError);
    expect([order, w.held().entries.length, w.held().state.signers[key]]).toEqual([[], entries, undefined]);
  });

  it("G7: after the confirm: the approval, then the entry signed and handed to the PC; where the list then fails, the card never says added to the PC", async () => {
    const { w, key, order, said, ways, approve } = await rang();
    await approve(pinnedX(w), true, { list: true, confirmed: true });
    expect([order.slice(0, 2), said, w.held().state.signers[key] !== undefined]).toEqual([["approve", "/api/account/list/head"], [null], true]);
    const again = await rang();
    again.member.wire.answer = (request) => request.method === "POST" && new URL(request.url).pathname.endsWith("/entries") ? Response.json({ error: { code: "list_stopped", message: "x" } }, { status: 503 }) : null;
    await again.approve(pinnedX(again.w), true, { list: true, confirmed: true });
    expect([again.order[0], again.said, again.ways]).toEqual(["approve", ["stopped"], [false]]);
    void ways;
  });
});

describe("held: the card is made only for the sign-in and the key the join signs with", () => {
  const LIST = "5c".repeat(32);
  const SERVICE = "https://account.ovis.sh";
  const signedIn = (account: string, id: string): AccountSession => ({ service: SERVICE, account, provider: "github", access_token: `access-${id}`, refresh_token: `refresh-${id}`, expires_at: Date.now() + 3_600_000, sign_in_id: id, signed_in_at: Date.now() });
  const waiting: AccountListView = { account: "acct-one", reached: true, status: { at: "not_in", list: LIST, why: "not_mine", claim: "claimed" }, devices: [], pcs: [] };

  /** A controller whose list answers `read` to each sync, after `during` ran (what another tab does while the read is out). */
  async function prepared(during: (accounts: AccountStore) => Promise<void>) {
    const accounts = memoryAccountStore();
    await accounts.set("session", signedIn("acct-one", "first"));
    const list = new Proxy({} as AccountList, { get: (_target, name) => {
      if (name === "sync") return async () => { await during(accounts); return waiting; };
      if (name === "view") return () => waiting;
      if (name === "subscribe") return () => () => {};
      if (name === "shown") return () => Math.floor(Date.now() / 1000);
      return () => null;
    } });
    ends.push(testPage());
    const controller = createAccountController({
      container: Object.create(null), entryUrl: "https://app.ovis.sh/", store: noPairings, accountStore: accounts, accountService: SERVICE, accountList: list,
      accountFetch: async (input) => new URL(new Request(input).url).pathname === "/v1/admissions" ? Response.json({}, { status: 201 }) : Response.json({ pcs: [] }),
      renderApp: () => ({ render() {}, unmount() {} }),
    }, { active: () => true, changed: async () => {}, outdated: () => new Set() });
    ends.push(() => controller.dispose());
    const offer = { v: 1 as const, server_id: "a1".repeat(16), server_public_key: exportPublicKey(generateKeyPair().publicKey), relay: "wss://relay.example" };
    return (await controller.prepare(offer, new AbortController().signal)).listCard;
  }

  it("G8: brings it where nothing changed, and none where another tab signed in again to the same account while the claim was read", async () => {
    expect(await prepared(async () => {})).toMatchObject({ list: LIST });
    expect(await prepared(async (accounts) => { await accounts.set("session", signedIn("acct-one", "second")); })).toBeUndefined();
  });

  it("G9: none where another tab replaced this device's account key while the claim was read", async () => {
    expect(await prepared(async (accounts) => { await accounts.clear(() => true); })).toBeUndefined();
  });
});

describe("held: one member key from the check before the approval to the add, on a PC that follows the list", () => {
  /** The page's copy of the list, as another tab may change it under the card, and a second full member key of the same list. */
  async function twoKeys(w: ReturnType<typeof listWorld>, member: WorldDevice) {
    let current = member.list;
    const page = new Proxy({} as AccountList, { get: (_target, name) => { const value = Reflect.get(current, name) as unknown; return typeof value === "function" ? value.bind(current) : value; } });
    const other = await w.device({ label: "Laptop" });
    await other.list.sync();
    const laptop = (await other.keys()).key;
    const allowed = await allowDevice(member.list, { key: laptop, label: "Laptop", os: null }, { wait: noWait });
    if (!allowed.allowed) throw new Error(`The laptop was not let in: ${allowed.why}`);
    await other.list.adopt(allowed.offer);
    return { page, laptop, swap: () => { current = other.list; } };
  }

  it("G10: a key replaced between the check and the first write: nothing is signed, under either key", async () => {
    const { w, member, key, said, approve } = await rang();
    const { page, swap } = await twoKeys(w, member);
    await approve(pinnedX(w), true, { list: true, confirmed: true }, page, swap);
    expect([w.held().state.signers[key], said]).toEqual([undefined, ["changed"]]);
  });

  it("G11: a key replaced while the entry was handed over: no introduction and no add follow", async () => {
    const { w, member, key, said, approve } = await rang();
    const { page, swap } = await twoKeys(w, member);
    const pc = pinnedX(w, swap);
    await approve(pc, true, { list: true, confirmed: true }, page);
    expect(w.held().state.signers[key]).toBeDefined();
    expect([pc.paths().filter((path) => path === "/api/account/introduce" || path === "/api/account/records"), said]).toEqual([[], [null, "changed"]]);
  });

  it("G12: a page whose list writes with another key than the account key the add would be signed with signs no add", async () => {
    const { w, member, said, approve } = await rang();
    const { page, swap } = await twoKeys(w, member);
    swap();
    const pc = pinnedX(w);
    await approve(pc, true, { list: true, confirmed: true }, page);
    expect([pc.paths().filter((path) => path === "/api/account/records"), said.at(-1)]).toEqual([[], "changed"]);
  });
});

describe("held: nothing is approved where the page's list is another account's", () => {
  it("G13: a page whose list follows another account (a sign-in changed in another tab) approves nothing on a PC that follows the list", async () => {
    const { w, key, order, approve } = await rang();
    // the page's copy of the list now belongs to another account, in which this device writes
    const elsewhere = listWorld("acct_other");
    const theirs = await elsewhere.device({ label: "Phone" });
    await theirs.list.sync();
    expect(theirs.list.writer()).not.toBeNull();
    const error = await approve(pinnedX(w), true, { list: true, confirmed: true }, theirs.list).then(() => null, (reason: unknown) => reason);
    expect([error instanceof ListAllowError ? error.why : error, order, w.held().state.signers[key]]).toEqual(["changed", [], undefined]);
  });
});
