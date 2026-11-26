/**
 * The first phone of a new account: a PC added in one press (one-press.contract.test.ts) has no account
 * member yet, so nobody could approve the account join its owner's first phone sends. Its own window shows that join
 * with the digits to compare, and its Allow lets the phone in; no other window sees or decides it. A PC with a member
 * keeps the member's approval.
 */
import { afterEach, expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { newRecordId, signSafetyRecord } from "../../shared/account-records.ts";
import { channelBinding, importPublicKey } from "../../shared/relay-e2ee.ts";
import { FrameType, PAIR_INTENT_ACCOUNT, PAIR_SAS_FEATURE, type MuxFrame } from "../../shared/relay-mux.ts";
import { fromBase64Url, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import { bounded, deferred, relayConnection } from "../relay/test-helpers.ts";
import { firstPairingRead, memberRow, pairingPc, phone, vouchFor, type Pc, type Phone } from "./pairing.test-helpers.ts";

const pcs: Pc[] = [];
afterEach(async () => { for (const pc of pcs.splice(0)) await pc.close(); });

const TOKEN = "first-phone-token";
/** This PC's own window: the access token from loopback, no proxy (dispatch.ts ownWindow). */
const own = { authorization: `Bearer ${TOKEN}` };
/** The same token through a proxy (a remote browser): a full window, but not this PC's own. */
const remote = { ...own, "x-forwarded-for": "100.64.0.9", "x-forwarded-proto": "https" };

async function startedPc(platform: NodeJS.Platform, rows?: readonly { created_at: string }[]): Promise<Pc> {
  const made = await pairingPc({ ...(rows ? { rows } : {}), server: { accountOpensAll: true, platform, token: TOKEN }, startRelay: false });
  made.account.opensAll = true;
  pcs.push(made);
  const started = await made.local("/api/relay/start", { method: "POST", headers: { ...own, "x-herdr-update": "1" } });
  if (started.status !== 200) throw new Error(`The relay did not start: ${JSON.stringify(started.body)}`);
  return made;
}

/** A PC added to acct_1 in one press on `platform`: in the account, with no member to approve a join. */
async function boundPc(platform: NodeJS.Platform): Promise<Pc> {
  const made = await startedPc(platform);
  const identity = made.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  const named = await made.local("/api/account/relay-account", { method: "POST", headers: { ...own, "x-herdr-machine": "1" }, body: { account: "acct_1" } });
  if (named.status !== 204) throw new Error(`The account was not named: ${named.status} ${JSON.stringify(named.body)}`);
  const token = made.account.issueToken("acct_1", { twoStep: true });
  const call = (path: string, method: string) => made.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(method === "PUT" ? { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" } : {}) }));
  await call(`/v1/pcs/${identity.server_id}`, "PUT");
  await call(`/v1/pcs/${identity.server_id}/admit`, "POST");
  const pressed = await made.local("/api/account/one-press", { method: "POST", headers: { ...own, "x-herdr-machine": "1" }, body: { account: "acct_1" } });
  if (pressed.status !== 200) throw new Error(`The PC was not added: ${pressed.status} ${JSON.stringify(pressed.body)}`);
  expect(made.devices.hasAccountApprover()).toBe(false);
  return made;
}

/** The phone's Join: admitted by the account service, then PAIR_REQUEST with the account intent and its reveal. */
async function join(pc: Pc, device: Phone) {
  await vouchFor(pc, "acct_1", device);
  const link = await relayConnection(pc);
  const frames: MuxFrame[] = [];
  let heard: (() => void) | undefined;
  link.onFrame = (frame) => { frames.push(frame); heard?.(); };
  const next = async (type: number): Promise<MuxFrame> => {
    for (;;) {
      const index = frames.findIndex((frame) => frame.type === type || frame.type === FrameType.SESSION_ERROR);
      if (index >= 0) return frames.splice(index, 1)[0]!;
      const arrived = deferred<void>();
      heard = arrived.resolve;
      await bounded(arrived.promise);
    }
  };
  await link.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const binding = channelBinding(link.channel);
  if (!binding) throw new Error("No channel binding");
  const nonce = randomPairNonce();
  link.mux.sendSession({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "Android · Chrome", public_key: device.spki, commitment: toBase64Url(pairCommitment(binding, device.spki, nonce)) } });
  const challenge = await next(FrameType.PAIR_CHALLENGE);
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`The join was refused: ${JSON.stringify(challenge.payload)}`);
  link.mux.sendSession({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  const digits = pairDigits(binding, device.spki, nonce, fromBase64Url(challenge.payload.nonce));
  return { link, next, challenge: challenge.payload, digits };
}

/** Resolves once the PC holds a join for its own window (its digits shown, or typed when members can approve). */
function ownJoinWaiting(pc: Pc): Promise<void> {
  const approvals = pc.app.context.services.relay.approvals;
  const found = deferred<void>();
  const stop = approvals.subscribe(() => { if (approvals.ownJoins().length > 0) found.resolve(); });
  if (approvals.ownJoins().length > 0) found.resolve();
  return bounded(found.promise).finally(stop);
}

async function http(pc: Pc, path: string, headers: Record<string, string>, body?: unknown) {
  const base = `http://127.0.0.1:${pc.app.port}`;
  const response = await fetch(base + path, body === undefined ? { headers } : {
    method: "POST", headers: { origin: base, "x-herdr-update": "1", "content-type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, text, body: text === "" ? {} : JSON.parse(text) as { joins?: { id: string; label: string; digits?: string }[]; error?: { code: string } } };
}

for (const [platform, os] of [["darwin", "mac"], ["win32", "windows"]] as const) {
  test(`on ${platform}, a PC with no member shows its first phone's join in its own window, and Allow lets the phone in`, async () => {
    const pc = await boundPc(platform);
    const device = await phone();
    const waiting = ownJoinWaiting(pc);
    const { link, next, challenge, digits } = await join(pc, device);
    // the phone is told the PC itself decides, and which PC to look at
    expect(challenge.approve_on).toBe(os);
    await waiting;
    const listed = await http(pc, "/api/relay/joins", own);
    expect(listed.status).toBe(200);
    expect(listed.body.joins).toEqual([expect.objectContaining({ label: "Android · Chrome", digits })]);
    // no account member hears of it
    expect(pc.app.context.services.relay.approvals.remoteList()).toEqual([]);
    const allowed = await http(pc, "/api/relay/join", own, { id: listed.body.joins![0]!.id, decision: "approve" });
    expect(allowed.status).toBe(200);
    link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
    expect((await next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
    expect(pc.devices.hasKey(device.spki)).toBe(true);
  });

  test(`on ${platform}, Decline in the PC's own window refuses the first phone`, async () => {
    const pc = await boundPc(platform);
    const device = await phone();
    const waiting = ownJoinWaiting(pc);
    const { next } = await join(pc, device);
    await waiting;
    const listed = await http(pc, "/api/relay/joins", own);
    const declined = await http(pc, "/api/relay/join", own, { id: listed.body.joins![0]!.id, decision: "decline" });
    expect(declined.status).toBe(200);
    const ended = await next(FrameType.AUTH_OK);
    expect(ended.type === FrameType.SESSION_ERROR ? ended.payload.code : ended.type).toBe("auth_failed");
    expect(pc.devices.hasKey(device.spki)).toBe(false);
  });

  test(`on ${platform}, a window that is not the PC's own neither sees the first phone's join nor decides it`, async () => {
    const pc = await boundPc(platform);
    const device = await phone();
    const waiting = ownJoinWaiting(pc);
    const { digits } = await join(pc, device);
    await waiting;
    const seen = await http(pc, "/api/relay/joins", remote);
    expect(seen.status).toBe(403);
    expect(seen.text).not.toContain(digits);
    // nor through the stream every full window hears (relay-pairings)
    expect(pc.app.context.services.relay.approvals.list()).toEqual([]);
    const id = pc.app.context.services.relay.approvals.ownJoins()[0]!.id;
    expect((await http(pc, "/api/relay/join", remote, { id, decision: "approve" })).status).toBe(403);
    expect((await http(pc, "/api/relay/pairing", remote, { id, decision: "approve" })).status).not.toBe(200);
    expect(pc.app.context.services.relay.approvals.ownJoins()).toHaveLength(1);
  });
}

test("#16: a members join waits in the PC's own window for the typed number, one wrong entry ends it, and a locked PC lists nothing", async () => {
  const pc = await startedPc("darwin", [(await memberRow("acct_1")).row]);
  await firstPairingRead(pc);
  const device = await phone();
  const waiting = ownJoinWaiting(pc);
  const { next, digits } = await join(pc, device);
  await waiting;
  const listed = await http(pc, "/api/relay/joins", own);
  expect(listed.body.joins).toEqual([expect.objectContaining({ label: "Android · Chrome" })]);
  const wrong = digits === "000000" ? "111111" : "000000";
  const typed = await http(pc, "/api/relay/join", own, { id: listed.body.joins![0]!.id, digits: wrong });
  expect([typed.status, typed.body.error?.code]).toEqual([409, "wrong_digits"]);
  expect(pc.app.context.services.relay.approvals.ownJoins()).toEqual([]);
  const ended = await next(FrameType.AUTH_OK);
  expect(ended.type === FrameType.SESSION_ERROR ? ended.payload.code : ended.type).toBe("auth_failed");
  expect(pc.devices.hasKey(device.spki)).toBe(false);
  pc.app.context.services.safetyLog!.appendLock({ account: "acct_1" });
  const locked = await http(pc, "/api/relay/joins", own);
  expect([locked.status, locked.body.error?.code]).toEqual([403, "locked"]);
  expect((await http(pc, "/api/relay/join", own, { id: "x", digits: "123456" })).status).toBe(403);
});

/** What `ovis approve` sends from this PC's terminal (scripts/plugin.ts approvePairings): loopback, the same origin, x-herdr-machine. */
const terminal = (pc: Pc) => ({ ...own, "x-herdr-machine": "1", "x-herdr-update": "1", origin: `http://127.0.0.1:${pc.app.port}` });

test("#28: ovis approve, at this PC's terminal, lists a members join without its digits and lets it in with the six digits typed", async () => {
  const pc = await startedPc("darwin", [(await memberRow("acct_1")).row]);
  await firstPairingRead(pc);
  const device = await phone();
  const waiting = ownJoinWaiting(pc);
  const { link, next, digits } = await join(pc, device);
  await waiting;
  const listed = await http(pc, "/api/relay/joins", terminal(pc));
  expect(listed.status).toBe(200);
  expect(listed.body.joins).toEqual([expect.objectContaining({ label: "Android · Chrome" })]);
  expect(listed.text).not.toContain(digits);
  const typed = await http(pc, "/api/relay/join", terminal(pc), { id: listed.body.joins![0]!.id, digits });
  expect(typed.status).toBe(200);
  link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  expect((await next(FrameType.AUTH_OK)).type).toBe(FrameType.AUTH_OK);
  expect(pc.devices.hasKey(device.spki)).toBe(true);
});

test("#28: a members join the terminal lists is still a member's card, with three candidates, and the member's right pick decides it", async () => {
  const member = await memberRow("acct_1");
  const pc = await startedPc("darwin", [member.row]);
  await firstPairingRead(pc);
  const device = await phone();
  const waiting = ownJoinWaiting(pc);
  const { digits } = await join(pc, device);
  await waiting;
  expect((await http(pc, "/api/relay/joins", terminal(pc))).body.joins).toHaveLength(1);
  const approvals = pc.app.context.services.relay.approvals;
  const [card] = approvals.remoteList();
  expect(card!.choices).toHaveLength(3);
  expect(card!.choices).toContain(digits);
  expect(approvals.decideRemote(card!.id, true, digits, { id: member.row.id, label: "Account phone", role: "drive" }).outcome).toBe("decided");
  expect((await http(pc, "/api/relay/joins", terminal(pc))).body.joins).toEqual([]);
});

test("a PC with an account member keeps the member's approval: its own window gets no digits to tap, and the member is asked", async () => {
  const pc = await startedPc("darwin", [(await memberRow("acct_1")).row]);
  await firstPairingRead(pc);
  expect(pc.devices.hasAccountApprover()).toBe(true);
  const device = await phone();
  const waiting = ownJoinWaiting(pc);
  const { challenge } = await join(pc, device);
  expect(challenge.approve_on).toBeUndefined();
  await waiting;
  const listed = await http(pc, "/api/relay/joins", own);
  expect(listed.body.joins).toHaveLength(1);
  expect(listed.body.joins![0]).not.toHaveProperty("digits");
  expect(pc.app.context.services.relay.approvals.remoteList()).toHaveLength(1);
  const tapped = await http(pc, "/api/relay/join", own, { id: listed.body.joins![0]!.id, decision: "approve" });
  expect(tapped.status).not.toBe(200);
  expect(pc.app.context.services.relay.approvals.ownJoins()).toHaveLength(1);
});

test("a first join of a key a block here keeps out is marked held for ovis approve, and the device hears why its typed digits let it in nowhere", async () => {
  const pc = await boundPc("darwin");
  // a block in force on this PC closes it to every key that came after its target (devices.ts admissionAllowed)
  const [signer, target] = await Promise.all([phone(), phone()]);
  const record = await signSafetyRecord({ v: 1, kind: "block", account: "acct_1", target: target.spki, target_no: 2, signer: signer.spki, signer_no: 1, signed_at: new Date().toISOString(), nonce: newRecordId() }, signer.keys.privateKey);
  pc.app.context.services.safetyLog!.append({ record, got: "handed", asof: { signer_no: 1, target_no: 2, after: 2, joined: 2, signer_removed: false } });
  const device = await phone();
  const waiting = ownJoinWaiting(pc);
  const { link, next, digits } = await join(pc, device);
  await waiting;
  const listed = await http(pc, "/api/relay/joins", terminal(pc));
  expect(listed.body.joins).toEqual([expect.objectContaining({ digits, list_held: true })]);
  expect((await http(pc, "/api/relay/join", terminal(pc), { id: listed.body.joins![0]!.id, digits })).status).toBe(200);
  link.mux.sendSession({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });
  expect(await next(FrameType.AUTH_OK)).toMatchObject({ type: FrameType.SESSION_ERROR, payload: { code: "auth_failed", message: "list_held_here" } });
  expect(pc.devices.hasKey(device.spki)).toBe(false);
});
