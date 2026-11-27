/**
 * What an independent review of the PC's own Allow attacked (docs/account.md, "A PC allows a device into the list"):
 * two Allows at one head, a row this PC holds under the account's id with another role, what a device of the list
 * hears on its socket, a PC that follows no list, and guards the step's own tests left unpinned. Beside
 * list-allow.contract.test.ts, on the same footing: the fake account service, a state folder per PC and port 0.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, readBody } from "../../shared/account-list-entry.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, FrameType, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_SAS_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { handleRequest, type ServerContext } from "../dispatch.ts";
import { JOIN_HOLD_MS } from "./join-hold.ts";
import { createListedPc } from "./listed-pc.test-helpers.ts";
import { claimKey, listMember, TestList, type ListMember } from "./list.test-helpers.ts";
import { ask, memberRow, pairingPc, setUpFor, signIn, vouchFor, type Pc } from "./pairing.test-helpers.ts";
import { RelayPairingApprovals } from "../relay/pairing-approvals.ts";

const ACCOUNT = "acct_1";
const TOKEN = "review-p6-token";
const own = { authorization: `Bearer ${TOKEN}` };
const MEMBER_WAIT_MS = 1_500;

const pcs: Pc[] = [];
const closes: (() => void)[] = [];
afterEach(async () => {
  for (const pc of pcs.splice(0)) await pc.close();
  for (const close of closes.splice(0)) close();
});

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** As list-allow.contract.test.ts boundPc: a PC added in one press, no member in its devices.json. */
async function boundPc() {
  const hook: { on: Hook | null } = { on: null };
  const made = await pairingPc({ server: { accountOpensAll: true, platform: "linux", token: TOKEN, accountListMemberWaitMs: MEMBER_WAIT_MS }, startRelay: false,
    accountFetch: (request, service) => hook.on ? hook.on(request, () => service.fetch(request)) : service.fetch(request) });
  made.account.opensAll = true;
  made.account.listAccounts = "*";
  pcs.push(made);
  const local = (path: string, body: unknown, header: string) => made.local(path, { method: "POST", headers: { ...own, [header]: "1" }, body });
  if ((await local("/api/relay/start", undefined, "x-herdr-update")).status !== 200) throw new Error("The relay did not start");
  const { services } = made.app.context;
  const identity = services.relay.currentIdentity()!;
  const endpoint = bytesToHex(importPublicKey(identity.public_key));
  if ((await local("/api/account/relay-account", { account: ACCOUNT }, "x-herdr-machine")).status !== 204) throw new Error("The account was not named");
  const token = made.account.issueToken(ACCOUNT, { twoStep: true });
  const call = (path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: endpoint, relay: "wss://relay.ovis.sh" } : {}) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT");
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await local("/api/account/one-press", { account: ACCOUNT }, "x-herdr-machine");
  if (pressed.status !== 200) throw new Error(`The PC was not added: ${pressed.status} ${JSON.stringify(pressed.body)}`);
  const list = services.accountList!;
  const pull = async () => { await services.accountMailbox.pull(); await list.settled(); };
  return { pc: made, services, serverId: identity.server_id, endpoint, list, pull, hook };
}
type Bound = Awaited<ReturnType<typeof boundPc>>;

/** Pins an already bound PC to a fresh list of its account, as a PC a person added (its own key signs for the list). */
async function pin(made: Bound, first?: (account: TestList) => Promise<void>) {
  const account = await TestList.start(made.pc.account, ACCOUNT);
  await first?.(account);
  await made.pull();
  expect(await made.list.wantList(account.id)).toMatchObject({ status: { pinned: false } });
  await account.addPostedPc(made.endpoint);
  await made.pull();
  expect(made.list.status()).toMatchObject({ pinned: true, standing: "in" });
  const ownKey = made.pc.account.accountList(ACCOUNT)!.state.pcs[made.endpoint]!.key!;
  return { ...made, account, ownKey };
}

async function allowingPc(first?: (account: TestList) => Promise<void>) {
  return await pin(await boundPc(), first);
}

/** The new device's join: its admission, then PAIR_REQUEST with the account intent (or `features`), with its card where it says so. */
async function join(made: { pc: Pc; serverId: string }, device: ListMember, options: { card?: { enc: string; card: string }; features?: readonly string[]; session?: Parameters<typeof relayConnection>[1] } = {}) {
  await vouchFor(made.pc, ACCOUNT, { keys: device.keys, spki: device.key });
  const link = await relayConnection(made.pc, { serverId: made.serverId, ...options.session });
  const frames: MuxFrame[] = [];
  let heard: (() => void) | undefined;
  link.onFrame = (frame) => { frames.push(frame); heard?.(); };
  const next = async (type: number): Promise<MuxFrame> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type || frame.type === FrameType.SESSION_ERROR);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      const arrived = deferred<void>();
      heard = arrived.resolve;
      await bounded(arrived.promise, 30_000);
    }
  };
  await link.hello(options.features ?? [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT, ACCOUNT_LIST_ALLOW]);
  const welcome = await next(FrameType.WELCOME);
  if (welcome.type !== FrameType.WELCOME) throw new Error(`The HELLO was refused: ${JSON.stringify(welcome.payload)}`);
  const binding = channelBinding(link.channel);
  if (!binding) throw new Error("No channel binding");
  const nonce = randomPairNonce();
  link.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: {
    label: "Android · Chrome", public_key: device.key, commitment: toBase64Url(pairCommitment(binding, device.key, nonce)),
    ...(options.card ? { list_enc: options.card.enc, list_card: options.card.card } : {}),
  } });
  const challenge = await next(FrameType.PAIR_CHALLENGE);
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`The join was refused: ${JSON.stringify(challenge.payload)}`);
  link.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  const digits = pairDigits(binding, device.key, nonce, fromBase64Url(challenge.payload.nonce));
  return { link, next, digits, features: welcome.payload.features };
}

async function ownJoin(made: Bound): Promise<{ id: string; digits?: string; list?: boolean }> {
  const approvals = made.services.relay.approvals;
  const found = deferred<void>();
  const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
  if (approvals.ownJoins().length > 0) found.resolve();
  await bounded(found.promise).finally(stop);
  const base = `http://127.0.0.1:${made.pc.app.port}`;
  const listed = await (await fetch(`${base}/api/relay/joins`, { headers: own })).json() as { joins: { id: string; digits?: string; list?: boolean }[] };
  return listed.joins[0]!;
}

async function decide(made: Bound, body: unknown): Promise<number> {
  const base = `http://127.0.0.1:${made.pc.app.port}`;
  return (await fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...own }, body: JSON.stringify(body) })).status;
}

async function allowed(made: Bound, device: ListMember, card: { enc: string; card: string }) {
  const asked = await join(made, device, { card });
  const waiting = await ownJoin(made);
  expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
  asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  return { ...asked, answer: await asked.next(FrameType.AUTH_OK) };
}

/** Every entry text the PC sent to POST /v2/pc/list/entries, grouped by the place it was signed for (seq and prev): the body hashes. */
const entriesPlaced = (made: Bound) => made.pc.account.requests.filter((line) => line.includes("/v2/pc/list/entries")).length;

function bodiesByPlace(texts: readonly string[]): Map<string, Set<string>> {
  const places = new Map<string, Set<string>>();
  for (const text of texts) {
    const entry = entryFromText(text);
    const body = readBody(entry.body);
    const place = `${body.seq} ${body.prev}`;
    if (!places.has(place)) places.set(place, new Set());
    places.get(place)!.add(entryHash(entry.body));
  }
  return places;
}

describe("M1 (MEDIUM, X5): one place gets two signatures of this PC", () => {
  test("a second Allow while the PC's copy still shows the head the first was signed on signs no new entry for that place", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const sent: string[] = [];
    let lost = false;
    let readsDown = false;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") {
        sent.push(((await request.clone().json()) as { entries: string[] }).entries[0]!);
        const answer = await forward();
        // the service placed the first entry and its answer never arrives; the reads that would show it fail for a while
        if (!lost) { lost = true; readsDown = true; throw new Error("the answer was lost"); }
        return answer;
      }
      if (path === "/v2/pc/list/log" && readsDown) throw new Error("the read failed");
      return await forward();
    };
    const device = { key: phone.key, enc: phone.enc, card, label: "Phone" };
    // the first Allow ends unplaced as far as this PC knows (the device is told list_head_lost / list_service_away: "asking again may work")
    const first = await made.list.allowDevice(device, true);
    expect("refused" in first).toBe(true);
    // the device asks again a moment later, the service still unreadable: the PC's copy shows the same head
    await made.list.allowDevice(device, true);
    const places = bodiesByPlace(sent);
    // X5: the exact signed request is kept and sent again while the verified head has not moved
    for (const [place, bodies] of places) expect({ place, bodies: bodies.size }).toEqual({ place, bodies: 1 });
  }, 30_000);

  test("the same holds for two different devices: the second device's entry is never signed on the place the first already took", async () => {
    const made = await allowingPc();
    const [a, b] = [await listMember(), await listMember()];
    const cardA = await claimKey(made.pc.account, ACCOUNT, made.account.id, a);
    const cardB = await claimKey(made.pc.account, ACCOUNT, made.account.id, b);
    const sent: string[] = [];
    let lost = false;
    let readsDown = false;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") {
        sent.push(((await request.clone().json()) as { entries: string[] }).entries[0]!);
        const answer = await forward();
        if (!lost) { lost = true; readsDown = true; throw new Error("the answer was lost"); }
        return answer;
      }
      if (path === "/v2/pc/list/log" && readsDown) throw new Error("the read failed");
      return await forward();
    };
    await made.list.allowDevice({ key: a.key, enc: a.enc, card: cardA, label: "A" }, true);
    await made.list.allowDevice({ key: b.key, enc: b.enc, card: cardB, label: "B" }, true);
    for (const [place, bodies] of bodiesByPlace(sent)) expect({ place, bodies: bodies.size }).toEqual({ place, bodies: 1 });
  }, 30_000);

  test("a lying account service gets no second signature to show this PC a history the account's list does not hold", async () => {
    const made = await allowingPc();
    const [a, b] = [await listMember(), await listMember()];
    const cardA = await claimKey(made.pc.account, ACCOUNT, made.account.id, a);
    const cardB = await claimKey(made.pc.account, ACCOUNT, made.account.id, b);
    const sent: string[] = [];
    let lost = false;
    let readsDown = false;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") {
        sent.push(((await request.clone().json()) as { entries: string[] }).entries[0]!);
        const answer = await forward();
        if (!lost) { lost = true; readsDown = true; throw new Error("the answer was lost"); }
        return answer;
      }
      if (path === "/v2/pc/list/log" && readsDown) throw new Error("the read failed");
      return await forward();
    };
    await made.list.allowDevice({ key: a.key, enc: a.enc, card: cardA, label: "A" }, true);
    await made.list.allowDevice({ key: b.key, enc: b.enc, card: cardB, label: "B" }, true);
    // the account's list holds A at that place; the service kept the text of B's entry it answered head_moved to
    const real = made.pc.account.accountList(ACCOUNT)!;
    const placeOfA = real.state.signers[a.key]!.seq;
    const textOfB = sent.find((text) => { const body = readBody(entryFromText(text).body); return body.adds?.key === b.key && body.seq === placeOfA; });
    readsDown = false;
    // the service serves this PC B's entry in A's place, if it was given one: every entry it shows is signed, that place's by this PC's own key
    if (textOfB !== undefined) made.pc.account.tamperList(made.account.id, { reader: { server_id: made.serverId }, fork: [textOfB] });
    // (as the review wrote it, the read below ran only with such an entry; without one the PC must still read to hold A)
    await made.pull();
    made.list.tick();
    await made.list.settled();
    // with one signature per place the PC holds the account's own history only: A in, B out (B was never signed on A's place)
    expect({ a: made.list.role(a.key) ?? null, b: made.list.role(b.key) ?? null, signedOnPlaceOfA: textOfB !== undefined })
      .toEqual({ a: "drive", b: null, signedOnPlaceOfA: false });
  }, 30_000);
});

describe("M2 (MEDIUM): the join's receipt is lost where this PC holds a row under the account's id with another role", () => {
  test("a device this PC holds under its account id as watch-only is signed into the list from the own window, and is told its place", async () => {
    const bound = await boundPc();
    const phone = await listMember();
    // the phone paired here by digits before the PC followed a list: a row of this PC's own under the key's account id
    const before = await join(bound, phone);
    const first = await ownJoin(bound);
    expect(await decide(bound, { id: first.id, decision: "approve" })).toBe(200);
    before.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect((await before.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
    const id = accountDeviceId(bound.serverId, phone.key);
    expect(bound.pc.devices.has(id)).toBe(true);
    // the owner made it watch-only in Settings
    expect(bound.pc.devices.update(id, { role: "watch" })).not.toBeNull();
    const made = await pin(bound);
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    // the PC signed and placed the entry: the device is a full, driving member of the list (on every PC of the account)
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ as: "device", by: made.ownKey, ended: null });
    // and its session must tell it where (E6 case 1: AUTH_OK.list is the only way it learns its place on a pinned PC)
    expect({ type: answer.type, payload: answer.payload }).toMatchObject({ type: FrameType.AUTH_OK, payload: { list: { id: made.account.id } } });
  }, 30_000);
});

describe("M3 (MEDIUM): a device of the list never hears of a join by the remote-pairings event", () => {
  test("a device the list holds to drive with full power, signed in with its list key, is told the waiting join on its event socket, and told again once the new device confirmed", async () => {
    const made = await allowingPc();
    const member = made.account.first;
    const link = await relayConnection(made.pc, { serverId: made.serverId, websocket: made.pc.app.context.services.core.socketHandlers });
    await link.auth({ keys: member.keys, publicKey: member.key, id: accountDeviceId(made.serverId, member.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE]);
    const socket = link.openSocket();
    await socket.opened;
    socket.send({ type: "machine-events", enabled: true } as never);
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    await ownJoin(made);
    // the read over HTTP shows it: the device may allow it (list-allow.contract.test.ts)
    expect(((await ask(link, "/api/relay/pairings")).body.pairings as unknown[]).length).toBe(1);
    type Told = { type: string; event?: { type: string; pairings?: { confirmed?: boolean }[] } };
    const joins = (confirmed: boolean) => (message: Told) => message.type === "machine-event" && message.event?.type === "remote-pairings"
      && message.event.pairings?.length === 1 && (message.event.pairings[0]!.confirmed === true) === confirmed;
    // E6 and docs/account.md: "the remote-pairings event", "sent again" at the confirm
    const heard = async (check: (message: Told) => boolean) => {
      const until = performance.now() + 3_000;
      while (performance.now() < until && !socket.messages.some((message) => check(message as unknown as Told))) await Bun.sleep(25);
      return socket.messages.some((message) => check(message as unknown as Told));
    };
    // (the new device's session setup ends ten seconds in: both are looked for well inside it)
    const shown = await heard(joins(false));
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    const confirmed = await heard(joins(true));
    // the socket itself is live: it carries this PC's roster
    expect(socket.messages.some((message) => (message as unknown as Told).type === "machine-event")).toBe(true);
    expect({ shown, confirmed }).toEqual({ shown: true, confirmed: true });
  }, 40_000);
});

describe("L1 (LOW): a PC with no list tells a member approver something it did not before", () => {
  test("on a PC that follows no list, a waiting join a member reads gains nothing after the new device's confirm, and no event is sent again", async () => {
    const member = await memberRow(ACCOUNT);
    const made = await pairingPc({ rows: [member.row], server: { accountOpensAll: true } });
    made.account.opensAll = true;
    pcs.push(made);
    await setUpFor(made, ACCOUNT);
    const serverId = made.app.context.services.relay.currentIdentity()!.server_id;
    expect(made.app.context.services.accountList?.pinned() ?? false).toBe(false);
    const phone = await listMember();
    // an app of today: no card; the account intent, window closed, so the members decide it
    const asked = await join({ pc: made, serverId }, phone, { features: [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT] });
    const approver = await signIn(made, member.row.id, member.key);
    if ("error" in approver) throw new Error(`The member was not let in: ${approver.error}`);
    const read = async () => (await ask(approver.link, "/api/relay/pairings")).body.pairings as Record<string, unknown>[];
    const deadline = performance.now() + 5_000;
    while ((await read()).length === 0) { if (performance.now() > deadline) throw new Error("The join was never listed"); await Bun.sleep(20); }
    const before = (await read())[0]!;
    const events: number[] = [];
    const stop = made.app.context.services.relay.approvals.subscribeRemote(() => events.push(1));
    events.length = 0;
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    // for a second, nothing about this join changes on a PC with no list
    const until = performance.now() + 1_000;
    let after = before;
    while (performance.now() < until) { after = (await read())[0] ?? after; await Bun.sleep(25); }
    stop();
    expect(after).toEqual(before);
    expect(events).toHaveLength(0);
  }, 30_000);
});

describe("L2 (LOW): an account row on a PC with no list hears another refusal for the waiting joins", () => {
  test("GET /api/relay/pairings from an account-joined row of a PC that follows no list answers account_route_denied, as before", async () => {
    const { fixture, device, serverId } = await createListedPc((close) => closes.push(close));
    const ctx: ServerContext = {
      ...fixture.app.context,
      peer: { kind: "relay", device: { id: device.id, label: "Laptop", role: "drive" }, key: device.publicKey, sessionId: "test", serverId },
      timeout() {}, requestIP: () => null, upgrade: () => false,
    };
    expect(fixture.app.context.services.accountList?.pinned() ?? false).toBe(false);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() + JOIN_HOLD_MS);
    try {
      expect(ctx.services.accountRows?.store()?.access(device.id)).toEqual({ ok: true });
      const response = await handleRequest(new Request("https://relay.ovis.invalid/api/relay/pairings", { headers: { "x-herdr-machine": "1" } }), ctx);
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({ error: { code: "account_route_denied" } });
    } finally { clock.mockRestore(); }
  }, 30_000);
});

describe("guards of the step that its own tests left unpinned", () => {
  test("the session of a join into the list opens no socket either, also where this PC holds a row of its own under that id", async () => {
    const bound = await boundPc();
    const phone = await listMember();
    // as list-allow.contract.test.ts: the phone paired here by digits before the pin, a devices.json row under its account id
    const before = await join(bound, phone);
    const first = await ownJoin(bound);
    expect(await decide(bound, { id: first.id, decision: "approve" })).toBe(200);
    before.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect((await before.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
    const made = await pin(bound);
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    // a carrier that serves sockets, as the relay link's does
    const asked = await join(made, phone, { card: { enc: phone.enc, card }, session: { websocket: made.pc.app.context.services.core.socketHandlers } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect((await asked.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
    const socket = asked.link.openSocket("/ws");
    expect(await socket.opened.then(() => "open", () => "refused")).toBe("refused");
  }, 30_000);

  test("a join a member allowed is not let in while this PC itself holds the key back, though the member's entry is in the list", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await made.account.addDevice(phone);
    await made.pull();
    const admits = spyOn(made.services.devices, "admitsFromList").mockImplementation(() => false);
    try {
      expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false)).toEqual({ refused: "held_here", detail: null });
    } finally { admits.mockRestore(); }
  }, 30_000);

  test("a join with the pc intent is never taken as a join into the list, whatever it offers", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const link = await relayConnection(made.pc, { serverId: made.serverId });
    const welcome = deferred<MuxFrame>();
    link.onFrame = (frame) => { if (frame.type === FrameType.WELCOME && frame.payload.provisional !== true) welcome.resolve(frame); };
    await link.hello([PAIR_SAS_FEATURE, PAIR_INTENT_PC, ACCOUNT_LIST_ALLOW]);
    const answer = await bounded(welcome.promise);
    if (answer.type !== FrameType.WELCOME) throw new Error("no WELCOME");
    expect(answer.payload.features).not.toContain(ACCOUNT_LIST_ALLOW);
    void phone;
  }, 30_000);

  test("a device let in by the list whose entry carries another encryption key is no receipt for this join", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const other = await listMember();
    // the list holds this key with an encryption key the device did not send with this join
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await made.account.addDevice(phone);
    await made.pull();
    expect(await made.list.allowDevice({ key: phone.key, enc: other.enc, card, label: "Phone" }, false)).toMatchObject({ refused: "not_in_list" });
  }, 30_000);

  test("while the relay refuses new devices, the PC signs nobody into the list", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let refusing = false;
    const asked = await join(made, phone, { card: { enc: phone.enc, card }, session: { refuseNewDevice: () => refusing } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    refusing = true;
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    const until = performance.now() + 3_000;
    while (performance.now() < until && entriesPlaced(made) === 0) await Bun.sleep(50);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  }, 30_000);

  test("PIN (X3): Revoke all while the entry is being written: the PC left its account, and nothing is placed", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let revoked = false;
    made.hook.on = async (request, forward) => {
      if (!revoked && new URL(request.url).pathname === "/v2/pc/list/wraps") { revoked = true; made.pc.devices.revokeAll(); }
      return await forward();
    };
    const outcome = await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, true);
    expect(revoked).toBe(true);
    expect("refused" in outcome).toBe(true);
    expect(entriesPlaced(made)).toBe(0);
  }, 30_000);

  test("PIN (X3, R2-7): the server stops while the entry is being written: nothing is placed after the stop", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let stopped = false;
    made.hook.on = async (request, forward) => {
      if (!stopped && new URL(request.url).pathname === "/v2/pc/list/wraps") { stopped = true; made.list.stop(); }
      return await forward();
    };
    const outcome = await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, true);
    expect(stopped).toBe(true);
    expect(outcome).toMatchObject({ refused: "unavailable" });
    expect(entriesPlaced(made)).toBe(0);
  }, 30_000);

  test("an entry the service takes at the last of the four tries lets the device in", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let refusals = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v2/pc/list/entries" && refusals < 3) { refusals++; return Response.json({ error: { code: "try_again", message: "again" } }, { status: 409 }); }
      return await forward();
    };
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, true)).toMatchObject({ allowed: { id: made.account.id } });
    expect(refusals).toBe(3);
  }, 30_000);

  test("a join asked under this PC's add-me screen is no join a device of the list sees, though it brought a card", () => {
    const approvals = new RelayPairingApprovals();
    // one at a time: the step's own unit test asks this as a fourth, past MAX_PENDING_APPROVALS (3), so it is never asked
    const own = approvals.ask("Own screen", "444444", Date.now() + 90_000, { intent: "account", key: "k4", deviceId: "d4", localOnly: true, list: true });
    expect(own).not.toBeNull();
    expect(approvals.listJoins()).toEqual([]);
    approvals.ask("Later", "222222", Date.now() + 90_000, { intent: "account", key: "k2", deviceId: "d2", membersOnly: true, list: true });
    expect(approvals.listJoins().map((join) => join.label)).toEqual(["Later"]);
  });
});
