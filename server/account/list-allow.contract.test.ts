/**
 * A PC lets a new device into its account's signed list (docs/account.md, "A PC allows a device into the list"): a
 * person at the PC compares the digits in its own window, or types them at `ovis approve`, and the PC signs the entry
 * that lets the device in with its own list key. A PC that follows no list, and a join that brings no card, are let in
 * as before.
 */
import { afterEach, describe, expect, jest, spyOn, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join as pathJoin } from "node:path";
import { bytesToHex } from "@noble/hashes/utils.js";
import { entryFromText, entryHash, readBody } from "../../shared/account-list-entry.ts";
import { openSealed, openWrap, wrapFromText } from "../../shared/account-list-seal.ts";
import { readKind, readNames } from "../../shared/account-list.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { ACCOUNT_LIST_ALLOW, ACCOUNT_LIST_FEATURE, ACCOUNT_LISTING_ERRORS, FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { ACCOUNT_LIST_ALLOW_FILE, LIST_ALLOW_MS, LIST_MEMBER_WAIT_MS } from "./list-follow.ts";
import { claimKey, listMember, memberCard, TestList, type ListMember } from "./list.test-helpers.ts";
import { ask, pairingPc, vouchFor, type Pc } from "./pairing.test-helpers.ts";

const ACCOUNT = "acct_1";
const TOKEN = "list-allow-token";
/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const own = { authorization: `Bearer ${TOKEN}` };

/** How long the PCs of these tests wait for a member's entry: the real wait is LIST_MEMBER_WAIT_MS. */
const MEMBER_WAIT_MS = 1_500;

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

type Hook = (request: Request, forward: () => Promise<Response>) => Promise<Response>;

/** A PC added to the account in one press, with no member in its devices.json: a join is decided in its own window. */
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

/**
 * The same PC, pinned to the account's list as a PC a person added: its own key signs for the list. `first`: what
 * the list holds before the PC pins it (a device let in then waits no join hold on this PC).
 */
async function allowingPc(first?: (account: TestList) => Promise<void>) {
  const made = await boundPc();
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

type Bound = Awaited<ReturnType<typeof boundPc>>;

async function memberReadClock(run: (clock: { readonly now: () => number; readonly advanceTo: (ms: number) => Promise<void> }) => Promise<void>) {
  let elapsed = 0;
  const immediate = setImmediate;
  const clock = spyOn(performance, "now").mockImplementation(() => 1_000 + elapsed);
  jest.useFakeTimers();
  try {
    await run({ now: () => elapsed, advanceTo: async (ms) => {
      await new Promise<void>((resolve) => immediate(resolve));
      // Let each look and the account response settle before advancing the next timer.
      while (elapsed < ms) {
        const step = Math.min(100, ms - elapsed);
        elapsed += step;
        jest.advanceTimersByTime(step);
        await new Promise<void>((resolve) => immediate(resolve));
      }
    } });
  } finally {
    jest.useRealTimers();
    clock.mockRestore();
  }
}

const logLimited = (seconds: number) => Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": String(seconds) } });

/** The new device's join: its admission, then PAIR_REQUEST with the account intent, with its card where it says so. */
async function join(made: Bound, device: ListMember, options: { card?: { enc: string; card: string }; features?: readonly string[];
  /** members written into the PAIR_REQUEST as they are, past the encoder: what an app of another build might send */
  raw?: Record<string, unknown> } = {}) {
  await vouchFor(made.pc, ACCOUNT, { keys: device.keys, spki: device.key });
  const link = await relayConnection(made.pc, { serverId: made.serverId });
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
  if (options.raw !== undefined) {
    const { raw } = options;
    link.transformClientFrame = (bytes) => {
      if (bytes[1] !== FrameType.PAIR_REQUEST) return bytes;
      const payload = new TextEncoder().encode(JSON.stringify({ ...JSON.parse(new TextDecoder().decode(bytes.subarray(8))) as object, ...raw }));
      const frame = new Uint8Array(8 + payload.length);
      frame.set(bytes.subarray(0, 8));
      frame.set(payload, 8);
      return frame;
    };
  }
  await link.hello(options.features ?? [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT, ACCOUNT_LIST_ALLOW]);
  // the answer to this HELLO, not the WELCOME with no feature that rides ahead of it
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
  return { link, next, digits, features: welcome.payload.features, list: challenge.payload.list };
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

/** The whole Allow as a person does it: the device asks with its card, the PC's own window allows, the device confirms. */
async function allowed(made: Bound, device: ListMember, card: { enc: string; card: string }) {
  const asked = await join(made, device, { card });
  const waiting = await ownJoin(made);
  expect(waiting.digits).toBe(asked.digits);
  // the PC's own window and `ovis approve` are told that the list lets this join in
  expect(waiting.list).toBe(true);
  expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
  asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  return { ...asked, answer: await asked.next(FrameType.AUTH_OK) };
}

const entriesPlaced = (made: Bound) => made.pc.account.requests.filter((line) => line.includes("/v2/pc/list/entries")).length;

describe("a PC that a person added lets a new device into the list from its own window", () => {
  test("it signs the device's entry with its own key, the service places it, and the device is in the list and on this PC", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const { answer, features, link } = await allowed(made, phone, { enc: phone.enc, card });
    expect(features).toContain(ACCOUNT_LIST_ALLOW);
    if (answer.type !== FrameType.AUTH_OK) throw new Error(`The device was not let in: ${JSON.stringify(answer.payload)}`);

    // the list holds the entry, signed by this PC's key, and the service's word had no part in who signed
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.signers[phone.key]).toMatchObject({ as: "device", power: "full", ended: null, by: made.ownKey });
    expect(held.state.devices[phone.key]).toMatchObject({ role: "drive", until: null, enc: phone.enc });
    const seq = held.state.signers[phone.key]!.seq;
    const entry = entryFromText(held.entries[seq]!);
    expect(readBody(entry.body).signer).toBe(made.ownKey);

    // the device is told the list and the place of its entry over the session whose digits were compared
    expect(answer.payload).toMatchObject({ role: "drive", device_id: accountDeviceId(made.serverId, phone.key), list: { id: made.account.id, seq, hash: entryHash(entry.body) } });
    // it is a device of the list here, not a pairing of this PC's own, with no join hold
    expect(made.pc.devices.hasKey(phone.key)).toBe(false);
    expect(made.services.accountRows!.rows().map((row) => [row.key, row.state])).toContainEqual([phone.key, "live"]);
    expect(made.list.status()).toMatchObject({ devices: 2, head: { seq } });
    // the session of the join told the device where it is in the list, and serves nothing else: its key was sent with
    // the comparison, never signed with here
    expect((await ask(link, "/api/preferences")).status).toBe(403);
    // it signs in with its list key, as any device of the list, and that session is its own
    const again = await relayConnection(made.pc, { serverId: made.serverId });
    expect(await again.auth({ keys: phone.keys, publicKey: phone.key, id: accountDeviceId(made.serverId, phone.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toMatchObject({ role: "drive" });
    expect((await ask(again, "/api/preferences")).status).toBe(200);
  });

  test("the session of the join serves nothing also where this PC already holds that key by a pairing of its own", async () => {
    const bound = await boundPc();
    const phone = await listMember();
    // the phone paired here by digits before the PC followed a list: a row of this PC's own, under the key's account id
    const before = await join(bound, phone);
    const first = await ownJoin(bound);
    expect(await decide(bound, { id: first.id, decision: "approve" })).toBe(200);
    before.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect((await before.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
    expect(bound.pc.devices.has(accountDeviceId(bound.serverId, phone.key))).toBe(true);
    // then the PC is pinned, and the phone is let into the list from this PC's own window
    const account = await TestList.start(bound.pc.account, ACCOUNT);
    await bound.pull();
    await bound.list.wantList(account.id);
    await account.addPostedPc(bound.endpoint);
    await bound.pull();
    expect(bound.list.status()).toMatchObject({ pinned: true, standing: "in" });
    const made = { ...bound, account, ownKey: bound.pc.account.accountList(ACCOUNT)!.state.pcs[bound.endpoint]!.key! };
    const card = await claimKey(made.pc.account, ACCOUNT, account.id, phone);
    const { answer, link } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer.type).toBe(FrameType.AUTH_OK);
    // the comparison's session only told the device its place: the key was never signed with on it
    expect((await ask(link, "/api/preferences")).status).toBe(403);
    expect((await ask(link, "/api/devices")).status).toBe(403);
  });

  test("what the PC signs goes by its clock as it is now, never by the hour it saved: a device the saved hour would put past its time does not stop the names from being sealed", async () => {
    const borrowed = await listMember();
    const until = Math.floor(Date.now() / 1000) + 600;
    const made = await allowingPc(async (account) => { await account.addDevice(borrowed, { power: "bound", until }); });
    // the PC's clock once read a quarter of an hour ahead, and the PC saved that hour: for letting in, the borrowed device's time is over
    const real = Date.now();
    const ahead = spyOn(Date, "now").mockImplementation(() => real + 900_000);
    try {
      made.list.tick();
      await made.pull();
      expect(made.list.role(borrowed.key)).toBeNull();
    } finally { ahead.mockRestore(); }
    // the clock is right again: the borrowed device stays out (the saved hour refuses), and what the PC signs is by the clock now
    expect(made.list.role(borrowed.key)).toBeNull();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, true)).toMatchObject({ allowed: { id: made.account.id } });
    const held = made.pc.account.accountList(ACCOUNT)!;
    const body = readBody(entryFromText(held.entries[held.state.signers[phone.key]!.seq]!).body);
    const kind = readKind(body);
    // signed at the clock's own hour, and with its names: by the clock now nobody who holds the names' key is over its time
    expect(Math.abs(body.issued_at - Math.floor(Date.now() / 1000))).toBeLessThan(120);
    expect(kind?.kind === "device" && kind.sealed !== null).toBe(true);
  });

  test("a device this PC holds by a pairing under an id of its own still gets its receipt: the join's session names its place, and it then signs in by its list key over that pairing", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    // paired here with a code before: a row under an id that is not the account's for its key
    const paired = made.pc.devices.pairRelay(made.pc.devices.startPairing().code, "Phone", phone.key);
    expect(paired?.device.id).not.toBe(accountDeviceId(made.serverId, phone.key));
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const { answer, link } = await allowed(made, phone, { enc: phone.enc, card });
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK, payload: { device_id: accountDeviceId(made.serverId, phone.key), list: { id: made.account.id, seq: held.state.signers[phone.key]!.seq } } });
    // the receipt and nothing else
    expect((await ask(link, "/api/preferences")).status).toBe(403);
    const again = await relayConnection(made.pc, { serverId: made.serverId });
    expect(await again.auth({ keys: phone.keys, publicKey: phone.key, id: accountDeviceId(made.serverId, phone.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE])).toMatchObject({ role: "drive" });
  });

  test("an entry is dated by the PC's clock held against the list's own time: a member's entry dated ahead of this PC's clock is never followed by an earlier one", async () => {
    const made = await allowingPc();
    // a member whose clock runs five minutes ahead adds a device: the list's own time is that entry's
    const ahead = Math.floor(Date.now() / 1000) + 300;
    const tablet = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, tablet);
    const text = await made.account.sign({ kind: "device", key: tablet.key, power: "full", role: "drive", until: null, enc: tablet.enc, card, sealed: null, rotates: false }, made.account.first, undefined, ahead);
    await made.account.placeTexts([text]);
    await made.pull();
    const phone = await listMember();
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" }, true)).toMatchObject({ allowed: { id: made.account.id } });
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(readBody(entryFromText(held.entries[held.state.signers[phone.key]!.seq]!).body).issued_at).toBeGreaterThanOrEqual(ahead);
  });

  test("the device's name is sealed under the list's key, and the device is given that key", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await allowed(made, phone, { enc: phone.enc, card });
    const held = made.pc.account.accountList(ACCOUNT)!;
    const seq = held.state.signers[phone.key]!.seq;
    const kind = readKind(readBody(entryFromText(held.entries[seq]!).body));
    if (kind?.kind !== "device" || kind.sealed === null) throw new Error("The entry carries no names");
    // the wrap the PC sent with the entry opens with the device's own key, to the key the list committed to
    const wrap = held.wraps.find((item) => item.member === phone.enc && item.epoch === 0);
    const opened = await openWrap({ list: made.account.id, epoch: 0, commitment: held.state.epochs[0]!.opens, wrap: wrap ? wrapFromText(wrap.wrap) : null, member: phone.encKey });
    if (!opened.open) throw new Error(`The device cannot open its wrap: ${opened.why}`);
    expect(bytesToHex(opened.value.key)).toBe(bytesToHex(made.account.epochKey.key));
    const names = await openSealed({ place: { list: made.account.id, seq }, epoch: opened.value, sealed: kind.sealed.bytes });
    if (!names.open) throw new Error(`The names do not open: ${names.why}`);
    expect(readNames(names.value)).toEqual({ label: "Android · Chrome", os: null });
    // no log line and no answer of the PC named the device
    expect(JSON.stringify(made.list.status())).not.toContain("Android");
  });

  test("the digits typed at `ovis approve` do the same", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, digits: asked.digits })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.AUTH_OK });
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ as: "device", by: made.ownKey });
  });

  test("nothing is signed before both people said the digits match", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "decline" })).toBe(200);
    expect((await asked.next(FrameType.AUTH_OK)).type).toBe(FrameType.SESSION_ERROR);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });
});

describe("a join from an app that knows no signed list, on a pinned PC", () => {
  test("is marked to this PC's own window and terminal as one it cannot let in: the app offered no part of the list", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    // as an Ovis older than 0.5.10 asks: the account intent, and nothing of the list
    await join(made, phone, { features: [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT] });
    expect(await ownJoin(made)).toMatchObject({ list_unknown: true });
    expect((await ownJoin(made)).list).toBeUndefined();
  });

  test("a join that offered the list's part is not so marked, also where this PC took no card for it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    expect(await ownJoin(made)).not.toHaveProperty("list_unknown");
  });

  test("is approved by nothing on this PC's own window: neither its Allow nor its digits let it in, and it still waits", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const asked = await join(made, phone, { features: [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT] });
    const waiting = await ownJoin(made);
    const base = `http://127.0.0.1:${made.pc.app.port}`;
    const answer = async (body: unknown) => {
      const response = await fetch(`${base}/api/relay/join`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...own }, body: JSON.stringify(body) });
      return [response.status, ((await response.json()) as { error?: { code?: string } }).error?.code];
    };
    expect(await answer({ id: waiting.id, decision: "approve" })).toEqual([409, "list_unknown"]);
    expect(await answer({ id: waiting.id, digits: asked.digits })).toEqual([409, "list_unknown"]);
    // nothing was written for it, and the join waits until it ends by itself or is declined
    expect(made.pc.devices.hasKey(phone.key)).toBe(false);
    expect(made.services.relay.approvals.ownJoins().map((each) => each.id)).toEqual([waiting.id]);
    expect(await decide(made, { id: waiting.id, decision: "decline" })).toBe(200);
    expect(made.services.relay.approvals.ownJoins()).toEqual([]);
  });
});

describe("what the PC does when the entry does not go in", () => {
  /** A join the person allowed that the PC did not let in: the device hears what a refused join always heard. */
  async function refused(made: Awaited<ReturnType<typeof allowingPc>>, phone: ListMember, card: { enc: string; card: string }) {
    const before = made.pc.account.accountList(ACCOUNT)!.head;
    const { answer } = await allowed(made, phone, card);
    expect(answer.type === FrameType.SESSION_ERROR && answer.payload.code).toBe("auth_failed");
    // nothing was written in its place: no entry, no device of the list, no pairing of this PC's own
    expect(made.pc.account.accountList(ACCOUNT)!.head).toEqual(before);
    expect(made.pc.devices.hasKey(phone.key)).toBe(false);
    expect(made.services.accountRows!.rows().some((row) => row.key === phone.key)).toBe(false);
  }

  test("a device whose key no sign-in of the account claimed is not let in: the service's lock holds, and the PC asks once", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    await refused(made, phone, { enc: phone.enc, card: await memberCard(phone, made.account.id) });
    expect(entriesPlaced(made)).toBe(1);
  });

  test("a card that is not this key's for this list is never signed over, and the service is not asked", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const other = await listMember();
    // another device's card, and this device's card for another list
    await refused(made, phone, { enc: phone.enc, card: await memberCard(other, made.account.id) });
    await refused(made, phone, { enc: phone.enc, card: await memberCard(phone, "ab".repeat(32)) });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("one signature per place: an answer that is lost, and a read that fails after it, send the same entry again", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const sent: string[] = [];
    let lost = false;
    let reads = 0;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") {
        sent.push(((await request.clone().json()) as { entries: string[] }).entries[0]!);
        const answer = await forward();
        // the service placed it, and its answer never arrives
        if (!lost) { lost = true; throw new Error("the answer was lost"); }
        return answer;
      }
      // and the read that would have shown it fails once
      if (path === "/v2/pc/list/log" && lost && reads++ === 0) throw new Error("the read failed");
      return await forward();
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    // the name is sealed with fresh random bytes each time it is sealed: one text means one signature
    expect(sent.length).toBeGreaterThan(1);
    expect(new Set(sent).size).toBe(1);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ by: made.ownKey });
  });

  test("the PC signs by its own clock, whatever hour the account service names", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    // every answer of the log says it is tomorrow
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (new URL(request.url).pathname !== "/v2/pc/list/log" || !answer.ok) return answer;
      return Response.json({ ...await answer.json() as object, now: Math.floor(Date.now() / 1000) + 86_400 });
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    const held = made.pc.account.accountList(ACCOUNT)!;
    const signed = readBody(entryFromText(held.entries[held.state.signers[phone.key]!.seq]!).body).issued_at;
    expect(Math.abs(signed - Math.floor(Date.now() / 1000))).toBeLessThan(120);
  });

  test("a lock or a hold that comes while the entry is prepared signs nobody in: this PC's own word is asked again before each submission", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    // this PC comes to hold the key back while the Allow reads the list: after its first look, before it signs
    let denied = false;
    let armed = false;
    made.hook.on = async (request, forward) => {
      if (armed && new URL(request.url).pathname === "/v2/pc/list/log") denied = true;
      return await forward();
    };
    const admits = spyOn(made.services.devices, "admitsFromList").mockImplementation(() => !denied);
    try {
      const asking = await join(made, phone, { card: { enc: phone.enc, card } });
      const waiting = await ownJoin(made);
      armed = true;
      expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
      asking.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
      expect(await asking.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed" } });
    } finally { admits.mockRestore(); }
    expect(denied).toBe(true);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });
  test("an answer of the service's gateway that says nothing of the entry is no refusal: the log is read, and the device is let in by the entry that was placed", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let failed = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/entries" || failed++ > 0) return await forward();
      await forward();
      // placed, and the gateway in front of the service answers for it
      return new Response("bad gateway", { status: 502 });
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ by: made.ownKey });
  });

  test("a PC that spent its minute of list calls (a number check waited on) is let wait the time the service names: the device is let in by the entry placed", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    // the service's own answer past a PC's 30 list calls in a minute (MACHINE_LIMITER): the entry is placed with the
    // 30th, and the read after it and the entry sent again meet the limit until the minute is over
    const limited = () => Response.json({ error: { code: "rate_limited", message: "Too many requests; try again later" } }, { status: 429, headers: { "retry-after": "2" } });
    let placed = false;
    let resent = 0;
    let limitedAt: number | null = null;
    let againAt: number | null = null;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/v2/pc/list")) return await forward();
      if (path === "/v2/pc/list/entries" && !placed) { placed = true; return await forward(); }
      if (!placed || resent > 1) return await forward();
      if (path === "/v2/pc/list/entries") {
        resent += 1;
        if (resent === 1) { limitedAt = performance.now(); return limited(); }
        againAt = performance.now();
        return await forward();
      }
      return resent === 0 ? limited() : await forward();
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ by: made.ownKey });
    // sent again only after the two seconds the service named (a timer may fire a moment early)
    expect(againAt! - limitedAt!).toBeGreaterThanOrEqual(1_980);
  });

  test("a wait the service names that would outlast the device's wait for its entry is not taken: the device is refused, and nothing is placed after it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const realNow = Date.now.bind(Date);
    let spent = 0;
    const clock = spyOn(Date, "now").mockImplementation(() => realNow() + spent);
    let sent = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/entries") return await forward();
      sent += 1;
      // half a minute of the device's wait is gone by this answer, and the service names its whole next minute
      spent = 30_000;
      return Response.json({ error: { code: "rate_limited", message: "Too many requests; try again later" } }, { status: 429, headers: { "retry-after": "60" } });
    };
    try {
      const { answer } = await allowed(made, phone, { enc: phone.enc, card });
      expect(answer).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed" } });
    } finally { clock.mockRestore(); }
    expect(sent).toBe(1);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
    // the entry the service did not take is not kept for the next Allow to send after the device gave up
    expect(existsSync(pathJoin(made.pc.stateDir, ACCOUNT_LIST_ALLOW_FILE))).toBe(false);
  });

  test("the signed entry is kept beside the copy: a second Allow at the same head sends that very entry and signs no other", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    const sent: string[] = [];
    let away = true;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v2/pc/list/entries") {
        sent.push(((await request.clone().json()) as { entries: string[] }).entries[0]!);
        // nothing of the service answers: whether the entry was placed is not known
        if (away) throw new Error("no answer");
      }
      if (path === "/v2/pc/list/log" && away) throw new Error("no answer");
      return await forward();
    };
    expect(await made.list.allowDevice(device, true)).toMatchObject({ refused: "service_away" });
    const first = sent[0]!;
    expect(new Set(sent).size).toBe(1);
    // the person allows it again while the head has not moved: the same bytes go out
    sent.length = 0;
    expect(await made.list.allowDevice(device, true)).toMatchObject({ refused: "service_away" });
    expect(new Set(sent)).toEqual(new Set([first]));
    const kept = pathJoin(made.pc.stateDir, ACCOUNT_LIST_ALLOW_FILE);
    expect(existsSync(kept)).toBe(true);
    if (process.platform !== "win32") expect(statSync(kept).mode & 0o777).toBe(0o600);
    // the service answers again: that entry is placed, and no other was ever signed
    sent.length = 0;
    away = false;
    expect(await made.list.allowDevice(device, true)).toMatchObject({ allowed: { id: made.account.id } });
    expect(sent).toEqual([first]);
    // placed and read back: nothing is kept any more
    expect(existsSync(kept)).toBe(false);
  });

  test("this PC's own word is asked once more when its proof to the service is ready, right before the entry goes out", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    // the PC comes to hold the key back while it proves itself to the service for the placement
    let denied = false;
    // its word was asked at the start and when the entry was signed: the proof that follows is the placement's
    let asked = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname === "/v1/pc/challenge" && asked >= 2) denied = true;
      return await forward();
    };
    const admits = spyOn(made.services.devices, "admitsFromList").mockImplementation((key) => { if (key === phone.key) asked++; return !(denied && key === phone.key); });
    try {
      expect(await made.list.allowDevice(device, true)).toMatchObject({ refused: "held_here" });
    } finally { admits.mockRestore(); }
    expect(denied).toBe(true);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("a service that is reading the list again is asked after the time it names, and no sooner", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const at: number[] = [];
    // when the service refused, and when this PC next began on a placement (its proof comes first)
    let refusedAt: number | null = null;
    let nextAt: number | null = null;
    made.hook.on = async (request, forward) => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/pc/challenge" && refusedAt !== null) nextAt ??= performance.now();
      if (path !== "/v2/pc/list/entries") return await forward();
      at.push(Date.now());
      if (at.length === 1) {
        refusedAt = performance.now();
        return Response.json({ error: { code: "list_rebuilding", message: "reading the list again" } }, { status: 503, headers: { "retry-after": "2" } });
      }
      return await forward();
    };
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(asked.link.session.placing).toBe(false);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    // while the entry waits to be placed the session says so, which is what keeps its carrier open past the sign-in grace
    const deadline = Date.now() + 10_000;
    while (at.length === 0) { if (Date.now() > deadline) throw new Error("Nothing was placed"); await Bun.sleep(10); }
    expect(asked.link.session.placing).toBe(true);
    const answer = await asked.next(FrameType.AUTH_OK);
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(asked.link.session.placing).toBe(false);
    expect(at).toHaveLength(2);
    // from the refusal to the first request of the next try: the two seconds the service named (a timer may fire a moment early)
    expect(nextAt! - refusedAt!).toBeGreaterThanOrEqual(1_980);
  });

  test("the PC signs only for an approval from its own window: one from another browser that drives it signs nobody in", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const base = `http://127.0.0.1:${made.pc.app.port}`;
    // the pairing window is open, so the comparison is this PC's to decide, by any browser that drives it
    expect((await made.pc.local("/api/relay/link", { method: "POST", headers: { ...own, "x-herdr-update": "1" } })).status).toBe(200);
    const asking = await join(made, phone, { card: { enc: phone.enc, card } });
    const shown = deferred<{ id: string }>();
    const stop = made.services.relay.approvals.subscribe((listed) => { if (listed[0]) shown.resolve(listed[0]); });
    const waiting = await bounded(shown.promise).finally(stop);
    // a browser on the LAN with the access token: it drives this PC, and is not this PC's own window
    const answer = await fetch(`${base}/api/relay/pairing`, { method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", "x-forwarded-for": "100.64.0.9", ...own },
      body: JSON.stringify({ id: waiting.id, decision: "approve" }) });
    expect(answer.status).toBe(200);
    asking.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect(await asking.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed" } });
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("a head that moved under it is read, and the entry signed again on the new head", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let raced = false;
    made.hook.on = async (request, forward) => {
      if (!raced && new URL(request.url).pathname === "/v2/pc/list/entries") {
        raced = true;
        // a member lets another device in just before this PC's entry arrives
        await made.account.addDevice(await listMember());
      }
      return await forward();
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(entriesPlaced(made)).toBe(2);
    const held = made.pc.account.accountList(ACCOUNT)!;
    expect(held.state.signers[phone.key]).toMatchObject({ as: "device", by: made.ownKey, seq: held.head.seq });
    expect(made.list.status()).toMatchObject({ devices: 3 });
  });

  test("a head that keeps moving ends the tries: the device is not let in, and nothing is written", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.account.tamperList(made.account.id, { headMoved: true });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(4);
  });

  test("a service that is reading the list again is sent the same entry again, and then takes it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const sent: string[] = [];
    made.pc.account.tamperList(made.account.id, { rebuilding: true });
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/entries") return await forward();
      sent.push(JSON.stringify((await request.clone().json() as { entries: string[] }).entries));
      const answer = await forward();
      made.pc.account.untamperList(made.account.id);
      return answer;
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]!);
  });

  test("a service that changes the list for nobody ends it at once", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.account.tamperList(made.account.id, { stopped: true });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(1);
    // what the PC holds is as it was: its own devices still get in
    expect(made.list.status()).toMatchObject({ pinned: true, standing: "in" });
  });

  test("an answer that is lost is no refusal: the log says the entry is in, and the device is let in", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    let lost = false;
    made.hook.on = async (request, forward) => {
      const answer = await forward();
      if (!lost && new URL(request.url).pathname === "/v2/pc/list/entries") { lost = true; throw new Error("The answer was lost"); }
      return answer;
    };
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(entriesPlaced(made)).toBe(1);
  });

  test("a key this PC itself keeps out is signed for by nobody here", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    made.pc.devices.removeAccountKey(phone.key, ACCOUNT, { id: "a".repeat(32), issuedAt: new Date().toISOString() });
    await refused(made, phone, { enc: phone.enc, card });
    expect(entriesPlaced(made)).toBe(0);
  });
});

/**
 * #4720 review J2 (the lead's ruling): a join waits at most JOIN_ADMISSION_WAIT_MS for the account's word only where its
 * client offered `account-listing-errors-1`, which can hear why and try again. Any other join (another PC of the account,
 * an older app) waits as it always did and hears what it always heard.
 */
test("with the account's word late, a join that can hear why is refused at the bound, and one that cannot waits and is taken once the word comes", async () => {
  const made = await allowingPc();
  const [told, older] = [await listMember(), await listMember()];
  const cards = await Promise.all([told, older].map(async (device) => ({ enc: device.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, device) })));
  // the mailbox, where the PC reads both admissions, answers once the test lets it
  const word = deferred<void>();
  made.hook.on = async (request, forward) => {
    if (new URL(request.url).pathname === "/v1/pc/mailbox") await word.promise;
    return await forward();
  };
  try {
    const waiting = join(made, older, { card: cards[1]! });
    const refusal = await join(made, told, { card: cards[0]!, features: [PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT, ACCOUNT_LIST_ALLOW, ACCOUNT_LISTING_ERRORS] })
      .then(() => null, (error: unknown) => error instanceof Error ? error.message : String(error));
    expect(refusal).toBe(`The join was refused: ${JSON.stringify({ code: "account_unreachable", message: "account_unreachable" })}`);
    // the join that offered nothing is still waiting past that bound; the word comes, and it is taken
    word.resolve();
    expect((await waiting).list).toBe(made.account.id);
  } finally { word.resolve(); }
}, 60_000);

describe("a PC that cannot sign for a list lets a device in as before", () => {
  test("a PC that follows no list takes a PAIR_REQUEST whose list members are out of their form as it always did", async () => {
    // an app that sends the extension to a PC with no list must still pair there, whatever it sent
    for (const raw of [{ list_enc: "x" }, { list_card: "A".repeat(86) }, { list_enc: 7, list_card: "short" }]) {
      const made = await boundPc();
      const phone = await listMember();
      const asked = await join(made, phone, { raw });
      expect(asked.features).not.toContain(ACCOUNT_LIST_ALLOW);
      const waiting = await ownJoin(made);
      expect(waiting.digits).toBe(asked.digits);
      expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
      asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
      expect((await asked.next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
      expect(made.pc.devices.hasKey(phone.key)).toBe(true);
    }
  });

  test("a PC that takes a card refuses one that is out of its form", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    await expect(join(made, phone, { raw: { list_enc: phone.enc } })).rejects.toThrow("protocol_error");
  });

  test("a PC that follows no list does not take a card: the join makes its own pairing, and no list is named", async () => {
    const made = await boundPc();
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await memberCard(phone, "ab".repeat(32)) } });
    expect(asked.features).not.toContain(ACCOUNT_LIST_ALLOW);
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    const answer = await asked.next(FrameType.AUTH_OK);
    if (answer.type !== FrameType.AUTH_OK) throw new Error("The device was not let in");
    expect(answer.payload).not.toHaveProperty("list");
    expect(made.pc.devices.hasKey(phone.key)).toBe(true);
    expect(made.pc.account.requests.some((line) => line.includes("/v2/pc/list/entries"))).toBe(false);
  });

  test("on a pinned PC a join that brings no card records a pairing that opens nothing: the list holds no entry for it, and its session ends", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    // an app that knows joins into a list and sent no card (one that knows none is approved by nothing: list_unknown)
    const asked = await join(made, phone);
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    // the row has the account's id for the key, which the list alone answers for: no session by it
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed" } });
    expect(made.pc.devices.hasKey(phone.key)).toBe(true);
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
  });

  test("a PC on which an alarm stands takes no card: it lets nobody new into the list", async () => {
    const made = await allowingPc();
    expect(made.list.allowRefusal()).toBeNull();
    // the first device signs a second history from entry 0 that a device nobody saw signs on, and the service shows it to this PC
    made.pc.account.tamperList(made.account.id, { reader: { server_id: made.serverId }, fork: (await made.account.forkFromStart()).texts });
    await made.pull();
    made.list.tick();
    await made.list.settled();
    expect(made.list.status().alarm).toBe("fork");
    expect(made.list.allowRefusal()).toBe("alarm");
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await memberCard(phone, made.account.id) } });
    expect(asked.features).not.toContain(ACCOUNT_LIST_ALLOW);
  });

  test("a PC whose Ovis is older than what a member wrote into the list signs nobody in, and says that it is behind", async () => {
    const made = await allowingPc();
    made.pc.account.tamperList(made.account.id, { reader: { server_id: made.serverId }, inject: [await made.account.signLater()] });
    await made.pull();
    made.list.tick();
    await made.list.settled();
    expect(made.list.status()).toMatchObject({ pinned: true, standing: "in", behind: true });
    expect(made.list.allowRefusal()).toBe("behind");
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, true)).toEqual({ refused: "behind", detail: null });
    expect(entriesPlaced(made)).toBe(0);
    // the device is told which cause it was, so it can say that the PC needs an update
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    expect(waiting).toMatchObject({ list: true, list_behind: true });
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_pc_behind" } });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("a PC that joined by an invite, approved at itself, tells the device that cause: it lets nobody into the list itself", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const waiting = await ownJoin(made);
    // as the PC that joined by an invite answers the allow: it is in the list and signs for nobody
    const refusal = spyOn(made.list, "allowDevice").mockResolvedValue({ refused: "not_signer", detail: null });
    try {
      expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
      asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
      expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_not_signer" } });
    } finally { refusal.mockRestore(); }
    expect(entriesPlaced(made)).toBe(0);
  });

  test("the person's Decline at this PC of a waiting join drops what this PC kept signed for that device", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await join(made, phone, { card: { enc: phone.enc, card } });
    const declined = spyOn(made.list, "declinedHere");
    try {
      const waiting = await ownJoin(made);
      expect(await decide(made, { id: waiting.id, decision: "decline" })).toBe(200);
      expect(declined.mock.calls).toEqual([[phone.key]]);
    } finally { declined.mockRestore(); }
  });

  test("a PC that cannot sign for its list itself (it joined by an invite) says so of a join into the list before anybody approves it here", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    await join(made, phone, { card: { enc: phone.enc, card } });
    // as the PC that joined by an invite answers: it is in the list and signs for nobody
    const refusal = spyOn(made.list, "allowRefusal").mockReturnValue("not_signer");
    try { expect(await ownJoin(made)).toMatchObject({ list: true, list_not_signer: true }); } finally { refusal.mockRestore(); }
    expect(await ownJoin(made)).not.toHaveProperty("list_not_signer");
  });

  test("a PC that came in as its account moved, with no key of its own in the list, says that cause, never an invite, here and to the device", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    const refusal = spyOn(made.list, "allowRefusal").mockReturnValue("needs_keys");
    const allowed = spyOn(made.list, "allowDevice").mockResolvedValue({ refused: "needs_keys", detail: null });
    try {
      const waiting = await ownJoin(made);
      expect(waiting).toMatchObject({ list: true, list_needs_keys: true });
      expect(waiting).not.toHaveProperty("list_not_signer");
      expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
      asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
      expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_needs_keys" } });
    } finally { refusal.mockRestore(); allowed.mockRestore(); }
    expect(entriesPlaced(made)).toBe(0);
  });

  test("a key this PC itself keeps out (a block here) is marked so before anybody approves it, and the device hears that cause, not that it was not added", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    // the gate a block in force closes for every key that came after its target (devices.ts admissionAllowed)
    const gate = spyOn(made.services.devices, "admitsFromList").mockImplementation((key) => key !== phone.key);
    try {
      const waiting = await ownJoin(made);
      expect(waiting).toMatchObject({ list: true, list_held: true });
      expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
      asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
      expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_held_here" } });
    } finally { gate.mockRestore(); }
    expect(entriesPlaced(made)).toBe(0);
    expect(made.list.holdsBack(phone.key)).toBe(false);
  });

  test("the challenge names the list this PC follows, and a refusal says which cause it was", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    // no sign-in of the account claimed this key: the service places no entry for it
    const card = await memberCard(phone, made.account.id);
    const asked = await join(made, phone, { card: { enc: phone.enc, card } });
    expect(asked.list).toBe(made.account.id);
    const waiting = await ownJoin(made);
    expect(await decide(made, { id: waiting.id, decision: "approve" })).toBe(200);
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_not_claimed" } });
  });

  test("a device a person at this PC allows waits no join hold, also when a read let it in a moment before", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    // another member places the same device, and a pull makes its row here, in its hold, just before the Allow
    await made.account.addDevice(phone);
    await made.pull();
    expect(made.services.accountRows!.rows().find((row) => row.key === phone.key)).toMatchObject({ state: "hold" });
    const { answer } = await allowed(made, phone, { enc: phone.enc, card });
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK });
    expect(made.services.accountRows!.rows().find((row) => row.key === phone.key)).toMatchObject({ state: "live" });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("a member's approval signs nothing here: the PC waits a few seconds for the member's entry, and lets the device in by it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await claimKey(made.pc.account, ACCOUNT, made.account.id, phone);
    const device = { key: phone.key, enc: phone.enc, card, label: "Phone" };
    // the member's entry reaches the account service a moment after its approval reached this PC
    const waiting = made.list.allowDevice(device, false);
    await made.account.addDevice(phone);
    const outcome = await waiting;
    expect(outcome).toMatchObject({ allowed: { id: made.account.id, seq: made.account.place.seq } });
    expect(entriesPlaced(made)).toBe(0);
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toMatchObject({ by: made.account.first.key });
    // with no entry at all, it gives up and says the device is not in the list
    const other = await listMember();
    expect(await made.list.allowDevice({ key: other.key, enc: other.enc, card: await memberCard(other, made.account.id), label: "Other" }, false)).toMatchObject({ refused: "not_in_list" });
    expect(entriesPlaced(made)).toBe(0);
    // two waits for a member's entry, the second to its end: more than a test's five seconds
  }, 20_000);

  test("a PC the list removed is in no list, and says so before any card is sent", async () => {
    const made = await allowingPc();
    await made.account.remove(made.ownKey);
    await made.pull();
    expect(made.list.allowRefusal()).toBe("not_pinned");
    expect(made.list.canAllow()).toBe(false);
  });
});

/** The new device's person says the digits match, and this PC has taken it: the waiting join says so. */
async function confirmed(made: Bound, asked: Awaited<ReturnType<typeof join>>): Promise<void> {
  const told = deferred<void>();
  const stop = made.services.relay.approvals.subscribeList((joins) => { if (joins.some((waiting) => waiting.confirmed === true)) told.resolve(); });
  asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  await bounded(told.promise).finally(stop);
}

describe("a device of the list at a pinned PC, over its own session", () => {
  /** A device the list holds, signed in to this PC with its list key. */
  async function signedIn(made: Awaited<ReturnType<typeof allowingPc>>, device: ListMember) {
    const link = await relayConnection(made.pc, { serverId: made.serverId });
    await link.auth({ keys: device.keys, publicKey: device.key, id: accountDeviceId(made.serverId, device.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE]);
    return link;
  }
  type Waiting = { id: string; key: string; list?: boolean; choices: string[] };
  const waitingFor = async (link: Awaited<ReturnType<typeof signedIn>>) => await ask(link, "/api/relay/pairings") as { status: number; body: { pairings?: Waiting[]; error?: { code: string } } };

  test("one the list holds to drive with full power sees the join that waits and allows it: it signs the entry, and the PC lets the newcomer in by that entry", async () => {
    const made = await allowingPc();
    const member = await signedIn(made, made.account.first);
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    await ownJoin(made);
    const seen = await waitingFor(member);
    expect(seen.status).toBe(200);
    expect(seen.body.pairings).toHaveLength(1);
    expect(seen.body.pairings![0]).toMatchObject({ key: phone.key, list: true });
    // never the digits themselves: three numbers to pick the new device's from
    expect(seen.body.pairings![0]!.choices).toContain(asked.digits);
    // before the new device confirmed its digits the approval is refused, and the join waits as it did
    const body = { id: seen.body.pairings![0]!.id, decision: "approve", digits: asked.digits };
    const early = await ask(member, "/api/relay/pairing", { method: "POST", body });
    expect([early.status, early.body.error?.code]).toEqual([409, "not_confirmed"]);
    expect((await waitingFor(member)).body.pairings).toHaveLength(1);
    await confirmed(made, asked);
    const allowed = await ask(member, "/api/relay/pairing", { method: "POST", body });
    expect([allowed.status, allowed.body]).toEqual([200, { ok: true, device_id: accountDeviceId(made.serverId, phone.key) }]);
    // the member signs the newcomer's entry and places it; the PC signs nothing
    await made.account.addDevice(phone);
    const answer = await asked.next(FrameType.AUTH_OK);
    expect(answer).toMatchObject({ type: FrameType.AUTH_OK, payload: { list: { id: made.account.id, ...made.account.place } } });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("a wrong number from such a device lets nobody in, as from any approver", async () => {
    const made = await allowingPc();
    const member = await signedIn(made, made.account.first);
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    await ownJoin(made);
    const { id } = (await waitingFor(member)).body.pairings![0]!;
    const wrong = asked.digits === "000000" ? "000001" : "000000";
    await confirmed(made, asked);
    const refused = await ask(member, "/api/relay/pairing", { method: "POST", body: { id, decision: "approve", digits: wrong } });
    expect([refused.status, refused.body.error?.code]).toEqual([409, "wrong_digits"]);
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed" } });
  });

  test("a device the list holds only to watch, or with bound power, sees no join and allows none: its refusal has a name of its own", async () => {
    const [watcher, borrowed] = [await listMember(), await listMember()];
    const made = await allowingPc(async (account) => {
      await account.addDevice(watcher, { role: "watch", power: "bound" });
      await account.addDevice(borrowed, { role: "drive", power: "bound" });
    });
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    const waiting = await ownJoin(made);
    for (const device of [watcher, borrowed]) {
      const link = await signedIn(made, device);
      const seen = await waitingFor(link);
      expect([seen.status, seen.body.error?.code]).toEqual([403, "list_cannot_allow"]);
      const refused = await ask(link, "/api/relay/pairing", { method: "POST", body: { id: waiting.id, decision: "approve", digits: asked.digits } });
      expect([refused.status, refused.body.error?.code]).toEqual([403, "list_cannot_allow"]);
      // and it ends no join either
      const declined = await ask(link, "/api/relay/pairing", { method: "POST", body: { id: waiting.id, decision: "decline" } });
      expect([declined.status, declined.body.error?.code]).toEqual([403, "list_cannot_allow"]);
    }
    // the join still waits for somebody who may decide it
    expect((await ownJoin(made)).id).toBe(waiting.id);
  });

  test("the right is read from the list as it stands at the call: a device removed a moment ago has none", async () => {
    const tablet = await listMember();
    const made = await allowingPc(async (account) => { await account.addDevice(tablet); });
    const link = await signedIn(made, tablet);
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    const waiting = await ownJoin(made);
    expect((await waitingFor(link)).status).toBe(200);
    await made.account.remove(tablet.key);
    await made.pull();
    // its session ends with its place in the list; a call that raced the removal is refused
    const refused = await ask(link, "/api/relay/pairing", { method: "POST", body: { id: waiting.id, decision: "approve", digits: asked.digits } }).catch(() => null);
    expect(refused === null || refused.status === 403).toBe(true);
    expect((await ownJoin(made)).id).toBe(waiting.id);
  });

  test("a join that brought no card is this PC's own pairing, and no device of the list decides it", async () => {
    const made = await allowingPc();
    const member = await signedIn(made, made.account.first);
    const phone = await listMember();
    const asked = await join(made, phone);
    const waiting = await ownJoin(made);
    expect(waiting.list).toBeUndefined();
    expect((await waitingFor(member)).body.pairings).toEqual([]);
    const refused = await ask(member, "/api/relay/pairing", { method: "POST", body: { id: waiting.id, decision: "approve", digits: asked.digits } });
    expect([refused.status, refused.body.error?.code]).toEqual([404, "relay_pairing_gone"]);
    expect((await ownJoin(made)).id).toBe(waiting.id);
  });
});

describe("a join into the list a member allows from afar, on a pinned PC", () => {
  async function signedIn(made: Awaited<ReturnType<typeof allowingPc>>, device: ListMember) {
    const link = await relayConnection(made.pc, { serverId: made.serverId });
    await link.auth({ keys: device.keys, publicKey: device.key, id: accountDeviceId(made.serverId, device.key) }, [ACCOUNT_LIST_FEATURE], [ACCOUNT_LIST_FEATURE]);
    return link;
  }
  const waitingFor = async (link: Awaited<ReturnType<typeof signedIn>>) => (await ask(link, "/api/relay/pairings")).body.pairings as { id: string; confirmed?: boolean }[];

  test("the approver is told once the new device confirmed its digits, and signs only then: the PC waits for that entry from the confirm on", async () => {
    const made = await allowingPc();
    const member = await signedIn(made, made.account.first);
    const phone = await listMember();
    const asked = await join(made, phone, { card: { enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone) } });
    await ownJoin(made);
    const [waiting] = await waitingFor(member);
    expect(waiting!.confirmed).toBeUndefined();
    // the new device's person says the digits match: the join now says so to whoever may approve it
    const told = deferred<void>();
    const stop = made.services.relay.approvals.subscribeList((joins) => { if (joins.some((join) => join.confirmed === true)) told.resolve(); });
    asked.link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    await bounded(told.promise).finally(stop);
    expect((await waitingFor(member))[0]).toMatchObject({ id: waiting!.id, confirmed: true });
    // nothing is in the list for the device yet: a device that had cancelled before its confirm would be nobody's member
    expect(made.pc.account.accountList(ACCOUNT)!.state.signers[phone.key]).toBeUndefined();
    // the member approves, then signs and places the entry: the PC is still waiting for it
    expect((await ask(member, "/api/relay/pairing", { method: "POST", body: { id: waiting!.id, decision: "approve", digits: asked.digits } })).status).toBe(200);
    await made.account.addDevice(phone);
    expect(await asked.next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.AUTH_OK, payload: { list: { id: made.account.id, ...made.account.place } } });
    expect(entriesPlaced(made)).toBe(0);
  });

  test("the PC waits half a minute for the member's entry, and no less", () => {
    expect(LIST_MEMBER_WAIT_MS).toBeGreaterThanOrEqual(30_000);
    // and the session and its carrier leave it that time
    expect(LIST_ALLOW_MS).toBeGreaterThan(LIST_MEMBER_WAIT_MS);
  });

  test("the last look is a read begun when the wait is over: an entry placed while an earlier read was out is found", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    // every read of the log during the wait is held; the member's entry is placed while one is out
    let held: (() => void) | null = null;
    let reads = 0;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/log") return await forward();
      const answer = await forward();
      if (reads++ === 0) await new Promise<void>((resolve) => { held = resolve; });
      return answer;
    };
    const waiting = made.list.allowDevice(device, false);
    const deadline = performance.now() + 10_000;
    while (held === null) { if (performance.now() > deadline) throw new Error("The PC read no log"); await Bun.sleep(5); }
    await made.account.addDevice(phone);
    // the held read answers, with the old head, only once the wait is over
    expect(await bounded(waiting, MEMBER_WAIT_MS + 300).catch(() => "still waiting")).toBe("still waiting");
    (held as () => void)();
    expect(await waiting).toMatchObject({ allowed: { id: made.account.id } });
  });

  test("a member-approved join reads its entry after the PC's exhausted list budget resets", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    await made.account.addDevice(phone);
    let retryAt: number | null = null;
    made.hook.on = async (request, forward) => {
      if (new URL(request.url).pathname !== "/v2/pc/list/log") return await forward();
      retryAt ??= performance.now() + 2_000;
      if (performance.now() >= retryAt) return await forward();
      return Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "retry-after": "2" } });
    };

    expect(await made.list.allowDevice(device, false)).toMatchObject({ allowed: { id: made.account.id } });
  });

  test("member log retry keeps the normal interval when Retry-After is shorter", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    await made.account.addDevice(phone);
    await memberReadClock(async ({ now, advanceTo }) => {
      const reads: number[] = [];
      made.hook.on = async (request, forward) => {
        if (new URL(request.url).pathname !== "/v2/pc/list/log") return await forward();
        reads.push(now());
        return reads.length === 1 ? logLimited(1) : await forward();
      };
      const waiting = made.list.allowDevice(device, false);
      await advanceTo(3_500);
      expect(reads).toEqual([0, 3_000]);
      expect(await waiting).toMatchObject({ allowed: { id: made.account.id } });
    });
  });

  test("member log retry after a throttled final read can still find the entry", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await claimKey(made.pc.account, ACCOUNT, made.account.id, phone), label: "Phone" };
    await memberReadClock(async ({ now, advanceTo }) => {
      const release = deferred<void>();
      const reads: number[] = [];
      made.hook.on = async (request, forward) => {
        if (new URL(request.url).pathname !== "/v2/pc/list/log") return await forward();
        reads.push(now());
        if (reads.length === 2) return logLimited(5);
        if (reads.length === 3) await release.promise;
        return await forward();
      };
      const waiting = made.list.allowDevice(device, false);
      try {
        await advanceTo(1_000);
        await made.account.addDevice(phone);
        await advanceTo(12_000);
      } finally {
        release.resolve();
        await made.list.settled();
      }
      await advanceTo(12_100);
      expect(await waiting).toMatchObject({ allowed: { id: made.account.id } });
      expect(reads).toEqual([0, 3_000, 8_000]);
    });
  });

  test("member log retry stops waiting for an unanswered final read by the session deadline", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await memberCard(phone, made.account.id), label: "Phone" };
    await memberReadClock(async ({ advanceTo }) => {
      const release = deferred<void>();
      let reads = 0;
      made.hook.on = async (request, forward) => {
        if (new URL(request.url).pathname === "/v2/pc/list/log" && ++reads === 2) await release.promise;
        return await forward();
      };
      const answer: { refusal: string | null } = { refusal: null };
      const waiting = made.list.allowDevice(device, false).then((outcome) => { if ("refused" in outcome) answer.refusal = outcome.refused; });
      try {
        await advanceTo(LIST_ALLOW_MS);
        expect(reads).toBe(2);
        expect(answer.refusal).toBe("service_away");
      } finally {
        release.resolve();
        await made.list.settled();
      }
      await waiting;
    });
  });

  test("member log retry sends nothing after an in-flight read returns Retry-After past the session deadline", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const device = { key: phone.key, enc: phone.enc, card: await memberCard(phone, made.account.id), label: "Phone" };
    await memberReadClock(async ({ now, advanceTo }) => {
      const release = deferred<void>();
      const reads: number[] = [];
      made.hook.on = async (request, forward) => {
        if (new URL(request.url).pathname !== "/v2/pc/list/log") return await forward();
        reads.push(now());
        if (reads.length === 1) { await release.promise; return logLimited(10); }
        return await forward();
      };
      const waiting = made.list.allowDevice(device, false);
      try { await advanceTo(LIST_ALLOW_MS + 100); }
      finally { release.resolve(); await made.list.settled(); }
      await advanceTo(LIST_ALLOW_MS + 200);
      expect(reads).toEqual([0]);
      expect(await waiting).toMatchObject({ refused: "service_away" });
    });
  });

  test("a join nobody signs for ends as not in the list once that wait is over, and not before", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await memberCard(phone, made.account.id);
    const began = performance.now();
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false)).toEqual({ refused: "not_in_list", detail: null });
    expect(performance.now() - began).toBeGreaterThanOrEqual(MEMBER_WAIT_MS - 50);
  });
});

describe("a join a member allowed from afar", () => {
  test("is let in only when an entry of the list lets the device in: this PC signs nothing for it", async () => {
    const made = await allowingPc();
    const phone = await listMember();
    const card = await memberCard(phone, made.account.id);
    expect(await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false)).toEqual({ refused: "not_in_list", detail: null });
    expect(entriesPlaced(made)).toBe(0);
    // the member signs and places the entry itself; this PC reads it, and lets the device in
    await made.account.addDevice(phone);
    const outcome = await made.list.allowDevice({ key: phone.key, enc: phone.enc, card, label: "Phone" }, false);
    expect(outcome).toEqual({ allowed: { id: made.account.id, ...made.account.place } });
    expect(entriesPlaced(made)).toBe(0);
    expect(made.services.accountRows!.rows().map((row) => [row.key, row.state])).toContainEqual([phone.key, "live"]);
  });
});
