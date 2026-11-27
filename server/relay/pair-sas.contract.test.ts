import { join } from "node:path";
import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import {
  channelBinding, exportPublicKey, generateKeyPair, openClientSecureChannel, openDaemonSecureChannel,
} from "../../shared/relay-e2ee.ts";
import type { KeyPair, SecureChannel, Transport } from "../../shared/relay-e2ee.ts";
import { decodeFrame, encodeFrame, FrameType, PAIR_INTENT_ACCOUNT, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED, PAIR_SAS_FEATURE } from "../../shared/relay-mux.ts";
import type { MuxFrame } from "../../shared/relay-mux.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { fromBase64Url, PAIR_APPROVAL_MS, pairCommitment, pairDigits, randomPairNonce, toBase64Url } from "../../shared/relay-pair-sas.ts";
import type { RelayPairingRequest, RemotePairingRequest } from "../../shared/machines.ts";
import { readDeviceRegistry } from "../devices.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { rotateRelayIdentity } from "./identity.ts";
import { answerServerChallenge, deriveServerId } from "../../shared/relay-server-proof.ts";
import { bytesToHex } from "@noble/hashes/utils.js";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import { accountDeviceId } from "../../shared/account-records.ts";
import { RelaySession } from "./session.ts";
import type { RelaySessionOptions } from "./session.ts";
import { bounded, deferred, relayAccountFixture, relayConnection, relayDevice, relayFixture, TestClock } from "./test-helpers.ts";

type Fixture = ReturnType<typeof relayFixture>;
const fixtures: Fixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.close(); });

function fixture(): Fixture {
  const made = relayFixture(false, { accountOpensAll: false });
  made.app.context.services.relay.approvals.openWindow();
  fixtures.push(made);
  return made;
}

function duplex(): [Transport, Transport] {
  const make = (): Transport & { peer?: Transport; closed: boolean } => ({
    onmessage: null, onclose: null, onerror: null, closed: false,
    async send(data) {
      if (this.closed || !this.peer) throw new Error("Closed test transport");
      this.peer.onmessage?.({ data, isBinary: typeof data !== "string" });
    },
    close(code = 1000, reason = "") {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.(code, reason);
      this.peer?.close(code, reason);
    },
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

class Inbox {
  private readonly frames: MuxFrame[] = [];
  private waiter: ((frame: MuxFrame) => void) | undefined;
  push(data: string | ArrayBuffer): void {
    if (typeof data === "string") throw new Error("Unexpected plaintext string");
    const frame = decodeFrame(new Uint8Array(data));
    if (frame.type === FrameType.RECEIVED) return;
    if (this.waiter) { const resolve = this.waiter; this.waiter = undefined; resolve(frame); }
    else this.frames.push(frame);
  }
  next(): Promise<MuxFrame> {
    const queued = this.frames.shift();
    if (queued) return Promise.resolve(queued);
    const next = deferred<MuxFrame>();
    this.waiter = next.resolve;
    return bounded(next.promise);
  }
}

async function pc(f: Fixture, transport: Transport, keys: KeyPair, clock?: MuxClock, extra: Pick<RelaySessionOptions, "refuseNewDevice"> = {}) {
  let session: RelaySession | undefined;
  const opening = openDaemonSecureChannel(transport, { daemonKeyPair: keys, events: { onmessage: (data) => session?.receive(data) } });
  return {
    async start() {
      session = new RelaySession({
        channel: await opening, services: f.app.context.services, port: f.app.port,
        serverId: "0123456789abcdef0123456789abcdef", serverVersion: "0.4.20", minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 256 * 1024, ...(clock ? { clock } : {}), ...extra,
      });
      return session;
    },
  };
}

async function phone(transport: Transport, serverKey: string) {
  const inbox = new Inbox();
  const opened = deferred<void>();
  const closed = deferred<void>();
  const channel = await openClientSecureChannel(transport, {
    daemonPublicKeyB64: serverKey,
    events: { onopen: () => opened.resolve(), onmessage: (data) => inbox.push(data), onclose: () => closed.resolve() },
  });
  await bounded(opened.promise);
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const send = (frame: MuxFrame) => channel.send(encodeFrame(frame).slice().buffer).catch(() => {});
  return {
    channel, inbox, publicKey, keys, closed: closed.promise, send,
    binding: () => { const binding = channelBinding(channel); if (!binding) throw new Error("No binding"); return binding; },
    async hello(features = [PAIR_SAS_FEATURE]) {
      await send({ type: FrameType.HELLO, flags: 0, stream_id: 0, payload: { protocol: "ovis-mux", versions: [1], features, required_features: [] } });
      let welcome = await inbox.next();
      if (welcome.type === FrameType.WELCOME && welcome.payload.provisional && features.length > 0) welcome = await inbox.next();
      if (welcome.type !== FrameType.WELCOME) throw new Error(`Expected WELCOME, got ${welcome.type}`);
      return welcome.payload;
    },
  };
}

type Phone = Awaited<ReturnType<typeof phone>>;

async function compare(p: Phone): Promise<string> {
  const nonce = randomPairNonce();
  const binding = p.binding();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(binding, p.publicKey, nonce)) } });
  const challenge = await p.inbox.next();
  if (challenge.type !== FrameType.PAIR_CHALLENGE) throw new Error(`Expected PAIR_CHALLENGE, got ${challenge.type}`);
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  return pairDigits(binding, p.publicKey, nonce, fromBase64Url(challenge.payload.nonce));
}

const confirm = (p: Phone) => p.send({ type: FrameType.PAIR_CONFIRM, flags: 0, stream_id: 0, payload: { confirmed: true } });

function prompts(f: Fixture, check: (list: RelayPairingRequest[]) => boolean): Promise<RelayPairingRequest[]> {
  const found = deferred<RelayPairingRequest[]>();
  const stop = f.app.context.services.relay.approvals.subscribe((list) => { if (check(list)) found.resolve(list); });
  return bounded(found.promise).finally(stop);
}

async function direct(f: Fixture, clock?: MuxClock, extra: Pick<RelaySessionOptions, "refuseNewDevice"> = {}) {
  const keys = generateKeyPair();
  const [phoneSide, pcSide] = duplex();
  const end = await pc(f, pcSide, keys, clock, extra);
  const p = await phone(phoneSide, exportPublicKey(keys.publicKey));
  const session = await end.start();
  return { p, session };
}

async function sessionError(p: Phone): Promise<string> {
  for (;;) {
    const frame = await p.inbox.next();
    if (frame.type === FrameType.SESSION_ERROR) return frame.payload.code;
  }
}

test("a phone that offers the feature gets it, and pairs once its digits match and the owner approves", async () => {
  const f = fixture();
  const { p } = await direct(f);
  expect((await p.hello()).features).toEqual([PAIR_SAS_FEATURE]);
  const waiting = prompts(f, (list) => list.length === 1);
  const digits = await compare(p);
  const [request] = await waiting;
  expect(request?.digits).toBe(digits);
  expect(digits).toMatch(/^[0-9]{6}$/);
  // the owner's approval alone does not finish it: the phone has to say they match too
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  const before = f.app.context.services.devices.list(null).length;
  await confirm(p);
  const admitted = await p.inbox.next();
  expect(admitted.type).toBe(FrameType.AUTH_OK);
  const devices = f.app.context.services.devices.list(null);
  expect(devices.length).toBe(before + 1);
  expect(devices.at(-1)).toMatchObject({ label: "New phone", role: "drive", via_relay: true });
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("on a pinned PC, a comparison approved for a key the list does not hold records the pairing and opens no session by it", async () => {
  const f = fixture();
  const { devices, relay } = f.app.context.services;
  // the PC follows its account's list, and the list holds no device under this key
  const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
  const role = spyOn(devices, "listRoleOf").mockReturnValue(null);
  try {
    const { p } = await direct(f);
    await p.hello();
    const waiting = prompts(f, (list) => list.length === 1);
    const digits = await compare(p);
    const [request] = await waiting;
    expect(request?.digits).toBe(digits);
    expect(relay.approvals.decide(request!.id, true)).toBe(true);
    const before = devices.list(null).length;
    await confirm(p);
    // no AUTH_OK: the row is the account's id for the key, which the list alone answers for
    expect(await sessionError(p)).toBe("auth_failed");
    expect(devices.list(null).length).toBe(before + 1);
  } finally { followed.mockRestore(); role.mockRestore(); }
});

test("on a pinned PC, a code used for a key that holds a row under the account's id makes a pairing under an id of its own, which is the PC's own business", async () => {
  const f = fixture();
  const { devices, relay } = f.app.context.services;
  const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
  const role = spyOn(devices, "listRoleOf").mockReturnValue(null);
  try {
    // the row: a comparison approved at the PC for a key the list does not hold
    const { p } = await direct(f);
    await p.hello();
    const waiting = prompts(f, (list) => list.length === 1);
    await compare(p);
    const [request] = await waiting;
    expect(relay.approvals.decide(request!.id, true)).toBe(true);
    await confirm(p);
    expect(await sessionError(p)).toBe("auth_failed");
    const row = devices.list(null).at(-1)!;
    const rows = devices.list(null).length;
    // the same key comes again with a code of this PC: the row it holds is reused, and the list still answers for it
    const again = await direct(f);
    await again.p.hello([]);
    await again.p.send({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code: devices.startPairing().code, label: "New phone", public_key: p.publicKey } });
    const answer = await again.p.inbox.next();
    // a new row, under an id that is not the account's for the key: the person at the PC made that pairing
    expect(answer.type).toBe(FrameType.AUTH_OK);
    expect(devices.list(null).length).toBe(rows + 1);
    expect(devices.list(null).at(-1)!.id).not.toBe(row.id);
  } finally { followed.mockRestore(); role.mockRestore(); }
});

test("an approved comparison leaves a pairing code that is still showing usable", async () => {
  const f = fixture();
  const code = f.app.context.services.devices.startPairing();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  await confirm(p);
  f.app.context.services.relay.approvals.decide(request!.id, true);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
  expect(f.app.context.services.devices.activePairing()?.code).toBe(code.code);
});

test("revoking every device ends a comparison under way, even one the owner already approved", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  f.app.context.services.devices.revokeAll();
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null)).toEqual([]);
});

test("revoking every device withdraws a prompt still waiting", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  f.app.context.services.devices.revokeAll();
  await cleared;
  expect(await sessionError(p)).toBe("auth_failed");
});

test("a phone that requires the feature is given it where this PC can bind the digits", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [PAIR_SAS_FEATURE], required_features: [PAIR_SAS_FEATURE] } });
  const welcome = await p.inbox.next();
  expect(welcome.type === FrameType.WELCOME && welcome.payload.features).toEqual([PAIR_SAS_FEATURE]);
});

test("an answer that lands after the comparison's deadline makes no device", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  f.app.context.services.relay.approvals.decide(request!.id, true);
  setSystemTime(new Date(Date.now() + PAIR_APPROVAL_MS + 1_000));
  try {
    await confirm(p);
    expect(await sessionError(p)).toBe("timeout");
  } finally { setSystemTime(); }
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
});

test("a PC whose owner copied no link without a code refuses a comparison before any prompt, and counts no failure", async () => {
  const made = relayFixture();
  fixtures.push(made);
  const { p } = await direct(made);
  await p.hello();
  const nonce = randomPairNonce();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "Ovis update - click Approve", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } });
  expect(await sessionError(p)).toBe("auth_failed");
  expect(made.app.context.services.relay.approvals.list()).toEqual([]);
  // twenty refusals later a QR code still pairs: the closed window spent none of the budget
  for (let index = 0; index < 20; index++) {
    const again = await direct(made);
    await again.p.hello();
    await again.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
      payload: { label: "x", public_key: again.p.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
    await sessionError(again.p);
  }
  const devices = made.app.context.services.devices;
  expect(() => devices.assertRelayPairing()).not.toThrow();
});

test("the window closes ten minutes after the link was copied", () => {
  const made = relayFixture();
  fixtures.push(made);
  const approvals = made.app.context.services.relay.approvals;
  approvals.openWindow(1_000);
  expect(approvals.windowOpen(1_000 + 10 * 60_000 - 1)).toBe(true);
  expect(approvals.windowOpen(1_000 + 10 * 60_000)).toBe(false);
});

test("the phone's word alone does not pair it: it waits for the owner", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  await confirm(p);
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
});

test("a phone that did not offer the feature is not given it, and a comparison without it is refused", async () => {
  const f = fixture();
  const { p } = await direct(f);
  expect((await p.hello([])).features).toEqual([]);
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(new Uint8Array(32)) } });
  expect(await sessionError(p)).toBe("protocol_error");
});

test("while its relay refuses new sessions, a comparison both people confirmed makes no device, and the relay is asked only then", async () => {
  const f = fixture();
  let asked = 0;
  const { p, session } = await direct(f, undefined, { refuseNewDevice: () => { asked++; return true; } });
  const failures = spyOn(f.app.context.services.devices, "noteRelayFailure");
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(true);
  // a phone nobody vouched for is no device yet: nothing of the limit is decided, or said, before both confirmed
  expect(asked).toBe(0);
  await confirm(p);
  await cleared;
  expect(asked).toBe(1);
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  // no failed pairing, and no session error: the relay closes this client, and the phone hears why from it
  expect(failures).not.toHaveBeenCalled();
  expect(session.mux.active).toBe(true);
  expect(session.verifying || session.pairing).toBe(false);
  // whatever the phone sends next is not answered
  await confirm(p);
  await session.mux.flush();
  expect(session.mux.active).toBe(true);
});

test("declining on the PC ends the pairing, makes no device and counts as a failed pairing", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  expect(f.app.context.services.relay.approvals.decide(request!.id, false)).toBe(true);
  expect(await sessionError(p)).toBe("auth_failed");
  await cleared;
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  // a decided pairing cannot be decided again, or approved after the fact
  expect(f.app.context.services.relay.approvals.decide(request!.id, true)).toBe(false);
});

test("an approval nobody asked for, or for a pairing already gone, approves nothing", async () => {
  const f = fixture();
  expect(f.app.context.services.relay.approvals.decide("0011223344556677", true)).toBe(false);
  const base = `http://127.0.0.1:${f.app.port}`;
  const response = await fetch(`${base}/api/relay/pairing`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-update": "1" },
    body: JSON.stringify({ id: "0011223344556677", decision: "approve" }),
  });
  expect(response.status).toBe(404);
  expect(((await response.json()) as { error: { code: string } }).error.code).toBe("relay_pairing_gone");
  const malformed = await fetch(`${base}/api/relay/pairing`, {
    method: "POST", headers: { origin: base, "content-type": "application/json", "x-herdr-update": "1" },
    body: JSON.stringify({ id: "0011223344556677", decision: "yes" }),
  });
  expect(malformed.status).toBe(400);
});

test("a revealed nonce that is not the committed one is refused before any prompt", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, randomPairNonce())) } });
  expect((await p.inbox.next()).type).toBe(FrameType.PAIR_CHALLENGE);
  // a phone that waits for the PC's nonce and then picks its own cannot keep its commitment
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(randomPairNonce()) } });
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a comparison taken before the window was closed raises no prompt when its digits come after the close", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const nonce = randomPairNonce();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
    payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } });
  expect((await p.inbox.next()).type).toBe(FrameType.PAIR_CHALLENGE);
  f.app.context.services.relay.approvals.closeWindow();
  f.app.context.services.relay.approvals.openWindow();
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a comparison approved on the PC makes no device when the phone confirms after the window was closed", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const shown = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [prompt] = await shown;
  expect(f.app.context.services.relay.approvals.decide(prompt!.id, true)).toBe(true);
  f.app.context.services.relay.approvals.closeWindow();
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null).filter((device) => device.label === "New phone")).toEqual([]);
});

test("replayed or out-of-order pairing frames end the session", async () => {
  const f = fixture();
  for (const replay of ["request-twice", "confirm-early", "reveal-early", "confirm-twice"] as const) {
    const { p } = await direct(f);
    await p.hello();
    const nonce = randomPairNonce();
    const request: MuxFrame = { type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
      payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } };
    if (replay === "reveal-early") {
      await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
    } else if (replay === "confirm-early") {
      await p.send(request);
      await p.inbox.next();
      await confirm(p);
    } else if (replay === "request-twice") {
      await p.send(request);
      await p.inbox.next();
      await p.send(request);
    } else {
      const waiting = prompts(f, (list) => list.length === 1);
      await compare(p);
      await waiting;
      await confirm(p);
      await confirm(p);
    }
    expect(await sessionError(p)).toBe("protocol_error");
    await bounded(p.closed);
  }
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a commitment and reveal replayed into another connection give other digits", async () => {
  const f = fixture();
  const first = await direct(f);
  await first.p.hello();
  const firstWaiting = prompts(f, (list) => list.length === 1);
  const nonce = randomPairNonce();
  const commitment = toBase64Url(pairCommitment(first.p.binding(), first.p.publicKey, nonce));
  await first.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "New phone", public_key: first.p.publicKey, commitment } });
  await first.p.inbox.next();
  await first.p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  await firstWaiting;
  // the same request and reveal in a second channel: its binding differs, so the commitment no longer holds
  const second = await direct(f);
  await second.p.hello();
  await second.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "New phone", public_key: first.p.publicKey, commitment } });
  await second.p.inbox.next();
  await second.p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  expect(await sessionError(second.p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list().length).toBe(1);
});

test("a comparison nobody finishes ends at its deadline and withdraws its prompt", async () => {
  const f = fixture();
  const clock = new TestClock();
  const { p } = await direct(f, clock);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  // well past the 10 s a code or a signature gets, the owner still has time
  clock.advance(15_000);
  expect(f.app.context.services.relay.approvals.list().length).toBe(1);
  const cleared = prompts(f, (list) => list.length === 0);
  // to the deadline exactly: further on, the mux's own 5 s teardown would beat its SESSION_ERROR
  clock.advance(PAIR_APPROVAL_MS - 15_000);
  expect(await sessionError(p)).toBe("timeout");
  await cleared;
});

test("a phone that leaves withdraws its prompt", async () => {
  const f = fixture();
  const { p } = await direct(f);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  await waiting;
  const cleared = prompts(f, (list) => list.length === 0);
  p.channel.close();
  await cleared;
});

test("at most three phones wait for approval at once", async () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const { p } = await direct(f);
    await p.hello();
    const waiting = prompts(f, (list) => list.length === index + 1);
    await compare(p);
    await waiting;
  }
  const { p } = await direct(f);
  await p.hello();
  await compare(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list().length).toBe(3);
});

/**
 * A relay that hands the phone a key of its own and opens its own channel to the PC: the phone's
 * Noise ends at the relay, and the relay's at the PC, so the two ends hold different bindings.
 */
async function intercepted(f: Fixture, rewrite: boolean) {
  const pcKeys = generateKeyPair();
  const relayKeys = generateKeyPair();
  const [phoneSide, relayFront] = duplex();
  const [relayBack, pcSide] = duplex();
  const end = await pc(f, pcSide, pcKeys);
  let toPc: SecureChannel | undefined;
  let toPhone: SecureChannel | undefined;
  const fromPc = new Inbox();
  let relayChallenge: Uint8Array | undefined;
  const fromPhone: MuxFrame[] = [];
  const relayPhoneNonce = randomPairNonce();
  const relayDeviceKey = await (async () => {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    return Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  })();
  const pcOpened = deferred<void>();
  const back = await openClientSecureChannel(relayBack, {
    daemonPublicKeyB64: exportPublicKey(pcKeys.publicKey),
    events: {
      onopen: () => pcOpened.resolve(),
      onmessage: (data) => {
        if (rewrite) { fromPc.push(data); return; }
        void toPhone?.send(data).catch(() => {});
      },
    },
  });
  toPc = back;
  const front = openDaemonSecureChannel(relayFront, {
    daemonKeyPair: relayKeys,
    events: {
      onmessage: (data) => {
        if (!rewrite) { void toPc?.send(data).catch(() => {}); return; }
        if (typeof data !== "string") fromPhone.push(decodeFrame(new Uint8Array(data)));
        void relay(data).catch(() => {});
      },
    },
  });
  // the rewriting relay runs the comparison with the PC as a phone of its own, committed before it sees anything
  const relay = async (data: string | ArrayBuffer) => {
    if (typeof data === "string") return;
    const frame = decodeFrame(new Uint8Array(data));
    const binding = channelBinding(back)!;
    if (frame.type === FrameType.PAIR_REQUEST) {
      await back.send(encodeFrame({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0,
        payload: { label: frame.payload.label, public_key: relayDeviceKey, commitment: toBase64Url(pairCommitment(binding, relayDeviceKey, relayPhoneNonce)) } }).slice().buffer);
      const challenge = await fromPc.next();
      if (challenge.type === FrameType.PAIR_CHALLENGE) relayChallenge = fromBase64Url(challenge.payload.nonce);
      await toPhone!.send(encodeFrame(challenge).slice().buffer);
    } else if (frame.type === FrameType.PAIR_REVEAL) {
      await back.send(encodeFrame({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(relayPhoneNonce) } }).slice().buffer);
    } else {
      await back.send(data);
      const answer = await fromPc.next();
      await toPhone!.send(encodeFrame(answer).slice().buffer);
    }
  };
  const p = await phone(phoneSide, exportPublicKey(relayKeys.publicKey));
  toPhone = await front;
  await bounded(pcOpened.promise);
  await end.start();
  const relaySide = () => ({ binding: channelBinding(back)!, deviceKey: relayDeviceKey, phoneNonce: relayPhoneNonce, pcNonce: relayChallenge! });
  return { p, relaySide };
}

test("a relay in the middle that passes the comparison on unchanged is refused: the commitment is bound to the phone's channel", async () => {
  const f = fixture();
  const { p } = await intercepted(f, false);
  expect((await p.hello()).features).toEqual([PAIR_SAS_FEATURE]);
  await compare(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
});

test("a relay in the middle that runs its own comparison with the PC shows the owner digits bound to another channel than the phone's", async () => {
  const f = fixture();
  const { p, relaySide } = await intercepted(f, true);
  await p.hello();
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(p);
  const [request] = await waiting;
  const relay = relaySide();
  // the PC shows the relay's comparison, made over the relay's own handshake with it, never the phone's
  expect(request?.digits).toBe(pairDigits(relay.binding, relay.deviceKey, relay.phoneNonce, relay.pcNonce));
  expect(Buffer.from(relay.binding).equals(Buffer.from(p.binding()))).toBe(false);
});

// One admission rule (docs/account.md, "Who may admit a device"): this PC itself, or a drive account
// member connected through the relay who picks the new device's digits out of three.

const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;

async function accountFixture(role: "drive" | "watch" = "drive") {
  const made = await relayAccountFixture(role, "acct_1", { accountOpensAll: false });
  fixtures.push(made.fixture);
  made.fixture.app.context.services.relay.approvals.openWindow();
  return { f: made.fixture, member: made.member };
}

type Link = Awaited<ReturnType<typeof relayConnection>>;

async function signedIn(f: Fixture, device: Awaited<ReturnType<typeof relayDevice>>): Promise<Link> {
  const link = await relayConnection(f);
  await link.auth(device);
  return link;
}

async function post(link: Link, target: string, body: unknown) {
  const request = link.open(target, { method: "POST", headers: guard, body: "stream" });
  void request.stream.sendBody(new Response(JSON.stringify(body)).body ?? new ReadableStream()).catch(() => {});
  const response = await request.response;
  return { status: response.status, body: await response.json() as { error?: { code: string }; ok?: boolean; device_id?: string } };
}

async function remoteList(link: Link) {
  const response = await link.open("/api/relay/pairings").response;
  return { status: response.status, body: await response.json() as { pairings?: RemotePairingRequest[]; error?: { code: string } } };
}

async function accountComparison(f: Fixture) {
  const { p } = await direct(f);
  await p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  const waiting = prompts(f, (list) => list.length === 1);
  const digits = await compare(p);
  const [request] = await waiting;
  return { p, digits, request: request! };
}

test("a phone may ask to join the account with its comparison, with one intent and only alongside pair-sas", async () => {
  const f = fixture();
  expect((await (await direct(f)).p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT])).features).toEqual([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  expect((await (await direct(f)).p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_PC])).features).toEqual([PAIR_SAS_FEATURE, PAIR_INTENT_PC]);
  expect((await (await direct(f)).p.hello([PAIR_INTENT_ACCOUNT])).features).toEqual([]);
  const { p } = await direct(f);
  await p.send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [PAIR_SAS_FEATURE, PAIR_INTENT_PC, PAIR_INTENT_ACCOUNT], required_features: [] } });
  expect(await sessionError(p)).toBe("protocol_error");
});

test("a drive account member through the relay admits a device by picking its digits, and the PC records who approved it", async () => {
  const { f, member } = await accountFixture();
  const link = await signedIn(f, member);
  const { p, digits, request } = await accountComparison(f);
  expect(request.intent).toBe("account");
  const remote = (await remoteList(link)).body.pairings?.[0];
  expect(remote).toMatchObject({ id: request.id, label: "New phone", intent: "account" });
  expect(remote).not.toHaveProperty("digits");
  expect(remote).not.toHaveProperty("vouched");
  expect(new Set(remote?.choices)).toEqual(new Set([digits, ...remote!.choices.filter((choice) => choice !== digits)]));
  expect(new Set(remote?.choices).size).toBe(3);

  expect(remote?.key).toBe(p.publicKey);
  const approved = await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits });
  const deviceId = accountDeviceId("0123456789abcdef0123456789abcdef", p.publicKey);
  expect(approved.body).toEqual({ ok: true, device_id: deviceId });
  await confirm(p);
  const admitted = await p.inbox.next();
  expect(admitted.type === FrameType.AUTH_OK && admitted.payload.device_id).toBe(deviceId);
  const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
  expect(registry.kind === "ok" && registry.devices.find((device) => device.label === "New phone")?.added_by).toBe(member.id);
});

test("a member's remote approval never lets in a key this PC holds back", async () => {
  const { f, member } = await accountFixture();
  const link = await signedIn(f, member);
  const { p, digits, request } = await accountComparison(f);
  f.app.context.services.accountHolds.hold([p.publicKey]);
  await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits });
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.hasKey(p.publicKey)).toBe(false);
});

test("every connected device hears of the admission and of the member that approved it", async () => {
  const { f, member } = await accountFixture();
  const approver = await signedIn(f, member);
  const bystander = await signedIn(f, await relayDevice(f));
  const streams = await Promise.all([approver, bystander].map(async (link) => (await link.open("/api/machines/events").response).body!.getReader()));
  const texts = ["", ""];
  const until = async (index: number, needle: string) => {
    while (!texts[index]!.includes(needle)) {
      const chunk = await bounded(streams[index]!.read());
      if (chunk.done) throw new Error(`The event stream ended before ${needle}`);
      texts[index] += new TextDecoder().decode(chunk.value);
    }
  };
  const { p, digits, request } = await accountComparison(f);
  // the member is told of the waiting device, with candidates and no digits
  await until(0, `"type":"remote-pairings","pairings":[{"id":"${request.id}"`);
  await post(approver, "/api/relay/pairing", { id: request.id, decision: "approve", digits });
  await confirm(p);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
  for (const index of [0, 1]) {
    // the streams opened on the earlier joins nobody has seen yet: this one is the join the member approved
    await until(index, `"approved_by":{"device_id":"${member.id}","label":"Account phone"}`);
    expect(texts[index]).not.toContain(`"digits":"${digits}"`);
    await streams[index]!.cancel();
  }
  expect(texts[1]).not.toContain('"type":"remote-pairings"');
});

test("a relay device that is not a drive account member can neither see nor decide a pairing, and the request keeps waiting", async () => {
  const { f } = await accountFixture();
  const outsider = await signedIn(f, await relayDevice(f));
  const { request } = await accountComparison(f);
  expect((await remoteList(outsider)).body.error?.code).toBe("account_required");
  expect((await post(outsider, "/api/relay/pairing", { id: request.id, decision: "approve", digits: request.digits })).body.error?.code).toBe("account_required");
  const watching = await accountFixture("watch");
  const watcher = await signedIn(watching.f, watching.member);
  const other = await accountComparison(watching.f);
  expect((await post(watcher, "/api/relay/pairing", { id: other.request.id, decision: "approve", digits: other.request.digits })).body.error?.code).toBe("read_only");
  expect(f.app.context.services.relay.approvals.list().map(({ id }) => id)).toEqual([request.id]);
  expect(watching.f.app.context.services.relay.approvals.list().map(({ id }) => id)).toEqual([other.request.id]);
});

test("a wrong pick refuses the device and counts against account pairings only", async () => {
  const { f, member } = await accountFixture();
  const link = await signedIn(f, member);
  for (let failure = 0; failure < 19; failure++) f.app.context.services.devices.noteRelayFailure("account");
  const { p, digits, request } = await accountComparison(f);
  const decoy = (await remoteList(link)).body.pairings![0]!.choices.find((choice) => choice !== digits)!;
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits: decoy })).body.error?.code).toBe("wrong_digits");
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
  // the twentieth failure paused account pairings, and nothing else
  const next = await direct(f);
  await next.p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  await next.p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Again", public_key: next.p.publicKey, commitment: toBase64Url(randomPairNonce()) } });
  expect(await sessionError(next.p)).toBe("auth_failed");
  const local = await direct(f);
  await local.p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_PC]);
  const waiting = prompts(f, (list) => list.length === 1);
  await compare(local.p);
  expect((await waiting)[0]?.intent).toBe("pc");
});

test("account pairing failures do not pause pairing with a code", async () => {
  const f = fixture();
  for (let failure = 0; failure < 20; failure++) f.app.context.services.devices.noteRelayFailure("account");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64url");
  const link = await relayConnection(f);
  const admitted = await link.pair(f.app.context.services.devices.startPairing().code, publicKey);
  expect(admitted.role).toBe("drive");
});

test("through the relay to a PC in an account only a drive account member may start a pairing code", async () => {
  const { f, member } = await accountFixture();
  const outsider = await signedIn(f, await relayDevice(f));
  expect((await post(outsider, "/api/devices/pair/start", {})).body.error?.code).toBe("account_required");
  const started = await post(await signedIn(f, member), "/api/devices/pair/start", {});
  expect(started.status).toBe(200);
});

test("a PC in no account still lets a driving relay device start a pairing code", async () => {
  const f = fixture();
  expect((await post(await signedIn(f, await relayDevice(f)), "/api/devices/pair/start", {})).status).toBe(200);
});

test("an approver revoked before the phone confirms admits nothing", async () => {
  const { f, member } = await accountFixture();
  const link = await signedIn(f, member);
  const { p, digits, request } = await accountComparison(f);
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits })).status).toBe(200);
  f.app.context.services.devices.revoke(member.id);
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null)).toEqual([]);
});

test("a comparison asking to join the account waits in the same three places as any other", async () => {
  const f = fixture();
  for (let index = 0; index < 3; index++) {
    const { p } = await direct(f);
    await p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_PC]);
    const waiting = prompts(f, (list) => list.length === index + 1);
    await compare(p);
    await waiting;
  }
  const { p } = await direct(f);
  await p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_ACCOUNT]);
  await compare(p);
  expect(await sessionError(p)).toBe("auth_failed");
});

test("an approval ends for good when its approver is given another role before the phone confirms", async () => {
  const { f, member } = await accountFixture();
  const link = await signedIn(f, member);
  const { p, digits, request } = await accountComparison(f);
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits })).status).toBe(200);
  f.app.context.services.devices.update(member.id, { role: "watch" });
  f.app.context.services.devices.update(member.id, { role: "drive" });
  await confirm(p);
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.list(null).some((device) => device.label === "New phone")).toBe(false);
});

test("a watch device on the PC's own address cannot read the digits of a waiting comparison", async () => {
  const f = fixture();
  const store = f.app.context.services.devices;
  const paired = store.pair(store.startPairing().code, "Watcher", "watch")!;
  store.match(paired.token);
  const { request } = await accountComparison(f);
  const response = await fetch(`http://127.0.0.1:${f.app.port}/api/relay/pairings`, { headers: { cookie: `ovis_device=${paired.token}` } });
  expect(response.status).toBe(403);
  expect(await response.text()).not.toContain(request.digits);
});

async function joinFixture(clock: () => number = Date.now, journal = false) {
  const service = new FakeAccountService(clock);
  service.opensAll = journal;
  const made = await relayAccountFixture("drive", "acct_1", { accountOpensAll: journal, platform: "linux", accountService: { url: "https://account.test", fetch: service.fetch } });
  fixtures.push(made.fixture);
  const identity = rotateRelayIdentity(made.fixture.stateDir);
  const tokens = { acct_1: service.issueToken("acct_1"), acct_2: service.issueToken("acct_2") };
  for (const token of Object.values(tokens)) {
    await service.fetch(new Request(`https://account.test/v1/pcs/${identity.server_id}`, { method: "PUT", headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" }) }));
  }
  const admit = (key: string, account: keyof typeof tokens = "acct_1") => service.fetch(new Request("https://account.test/v1/admissions", {
    method: "POST", headers: { authorization: `Bearer ${tokens[account]}` }, body: JSON.stringify({ server_id: identity.server_id, label: "Mac app", key }),
  }));
  if (journal) {
    service.registerDevice("acct_1", made.member.publicKey, "Account phone");
    expect(await made.fixture.app.context.services.accountMailbox.readSnapshot()).toMatchObject({ committed: true });
  }
  return { f: made.fixture, member: made.member, service, admit };
}

async function askToJoin(f: Fixture, admitKey?: (key: string) => Promise<unknown>, intent = PAIR_INTENT_ACCOUNT, identity?: { keys: KeyPair; replay?: string }) {
  const { p } = await direct(f);
  await p.hello([PAIR_SAS_FEATURE, intent, ...(identity ? ["pair-pc-proof"] : [])]);
  await admitKey?.(p.publicKey);
  const nonce = randomPairNonce();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "Mac app", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)), ...(identity ? { server_key: bytesToHex(identity.keys.publicKey) } : {}) } });
  const answer = await p.inbox.next();
  if (answer.type !== FrameType.PAIR_CHALLENGE) return { p, refused: answer.type === FrameType.SESSION_ERROR ? answer.payload.code : String(answer.type) };
  const digits = pairDigits(p.binding(), p.publicKey, nonce, fromBase64Url(answer.payload.nonce));
  const proof = identity && (identity.replay ?? answerServerChallenge(answer.payload.server_challenge, identity.keys.secretKey, { role: "vouched-pc", server_id: deriveServerId(identity.keys.publicKey), connection_id: toBase64Url(p.binding()) }));
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce), ...(proof ? { server_proof: proof } : {}) } });
  return { p, proof, digits };
}

function remotePrompt(f: Fixture): Promise<RemotePairingRequest> {
  const found = deferred<RemotePairingRequest>();
  const stop = f.app.context.services.relay.approvals.subscribeRemote((list) => { if (list[0]) found.resolve(list[0]); });
  return bounded(found.promise).finally(stop);
}

test("an account join outside the pairing window is refused without an admission, before any prompt and uncounted", async () => {
  const { f } = await joinFixture();
  expect((await askToJoin(f)).refused).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.remoteList()).toEqual([]);
  for (let index = 0; index < 19; index++) f.app.context.services.devices.noteRelayFailure("account");
  // the refusal above counted nothing: one more failure is still under the pause
  expect(() => f.app.context.services.devices.assertRelayPairing("account")).not.toThrow();
});

test("an admission for another key or another account does not open the way", async () => {
  const { f, admit } = await joinFixture();
  const otherKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).publicKey)));
  expect((await askToJoin(f, () => admit(otherKey))).refused).toBe("auth_failed");
  expect((await askToJoin(f, (key) => admit(key, "acct_2"))).refused).toBe("auth_failed");
});

test("an admission older than ten minutes does not open the way", async () => {
  const { f, admit } = await joinFixture(() => Date.now() - 11 * 60_000);
  expect((await askToJoin(f, (key) => admit(key))).refused).toBe("auth_failed");
});

test("a fresh admission for this key lets the join wait for a member, who still has to pick the digits", async () => {
  const { f, member, admit } = await joinFixture();
  const link = await signedIn(f, member);
  const prompt = remotePrompt(f);
  const { p, digits } = await askToJoin(f, (key) => admit(key));
  const request = await prompt;
  // the PC's own windows never see it, and cannot decide it
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
  expect(f.app.context.services.relay.approvals.decide(request.id, true)).toBe(false);
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits })).status).toBe(200);
  await confirm(p);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
});

test("outside the window only the account intent may join, and at most five a minute", async () => {
  const { f, admit } = await joinFixture();
  expect((await askToJoin(f, (key) => admit(key), PAIR_INTENT_PC)).refused).toBe("auth_failed");
  const outcomes: string[] = [];
  for (let index = 0; index < 6; index++) {
    const asked = await askToJoin(f, (key) => admit(key));
    outcomes.push(asked.refused ?? "taken");
    asked.p.channel.close();
  }
  expect(outcomes.filter((outcome) => outcome === "taken").length).toBeLessThanOrEqual(5);
  expect(outcomes.at(-1)).toBe("auth_failed");
});

test("refused requests do not spend the PC's account joins", async () => {
  const { f, admit } = await joinFixture();
  for (let index = 0; index < 5; index++) expect((await askToJoin(f)).refused).toBe("auth_failed");
  // the PC's regular pull sees the admission (a miss pulls at most every 10 seconds)
  const admitted = (key: string) => admit(key).then(() => f.app.context.services.accountMailbox.pull());
  expect((await askToJoin(f, admitted)).refused).toBeUndefined();
});

// Another PC of the account vouched for (docs/account.md, "Adding a PC of your account"): the account join's gates,
// window or not, shown to members as "pair this PC", a plain row once approved, and its own failure count.

const vouched = (f: Fixture, admitKey?: (key: string) => Promise<unknown>) => askToJoin(f, admitKey, PAIR_INTENT_VOUCHED, { keys: generateKeyPair() });

test("a legacy vouched PC without server proof is not given the intent, so it reads this PC as outdated, and is refused even with a fresh admission", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  // a 0.5.9 PC offers the intent without pair-pc-proof, and calls a PC that does not select the intent outdated
  expect((await (await direct(f)).p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_VOUCHED])).features).toEqual([PAIR_SAS_FEATURE]);
  expect((await askToJoin(f, key => admit(key), PAIR_INTENT_VOUCHED)).refused).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.remoteList()).toEqual([]);
});

test("a second vouched session cannot open while the first waits", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  const pending = remotePrompt(f);
  const first = await vouched(f, key => admit(key));
  await pending;
  // Both sessions have an invitation; a missing admission must not stand in for the concurrency gate.
  const second = await vouched(f, async key => { await admit(key); await f.app.context.services.accountMailbox.pull(); });
  expect(second.refused).toBe("auth_failed");
  first.p.channel.close();
});

test("a vouched request whose admission is still being checked holds no slot: a stranger cannot make a real PC's join fail", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  const mailbox = f.app.context.services.accountMailbox;
  const real = mailbox.admitted.bind(mailbox);
  const reached = deferred<void>();
  const held = deferred<boolean>();
  let first = true;
  mailbox.admitted = async (key: string) => {
    if (!first) return real(key);
    first = false;
    reached.resolve();
    return held.promise;
  };
  // a stranger with no admission asks first, and its check is still out
  const stranger = vouched(f);
  await bounded(reached.promise);
  const pending = remotePrompt(f);
  const member = await vouched(f, async (key) => { await admit(key); await mailbox.pull(); });
  expect(member.refused).toBeUndefined();
  await pending;
  held.resolve(false);
  expect((await stranger).refused).toBe("auth_failed");
  member.p.channel.close();
});

test("a server proof accepted in one vouched session cannot be replayed in another", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  const keys = generateKeyPair();
  const pending = remotePrompt(f);
  const first = await askToJoin(f, key => admit(key), PAIR_INTENT_VOUCHED, { keys });
  await pending;
  expect(typeof first.proof).toBe("string");
  if (!first.proof) throw new Error("Missing first server proof");
  first.p.channel.close();
  await first.p.closed;
  const second = await askToJoin(f, async key => { await admit(key); await f.app.context.services.accountMailbox.pull(); }, PAIR_INTENT_VOUCHED, { keys, replay: first.proof });
  expect(second.refused).toBeUndefined(); // B actually challenged the second session.
  expect(f.app.context.services.accountMailbox.currentAdmission(second.p.publicKey)).toBe(true);
  expect(await sessionError(second.p)).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.remoteList()).toEqual([]);
});

test("a PC vouched for is selected only alongside pair-sas, and alone among the intents", async () => {
  const f = fixture();
  expect((await (await direct(f)).p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_VOUCHED, "pair-pc-proof"])).features).toEqual([PAIR_SAS_FEATURE, PAIR_INTENT_VOUCHED]);
  expect((await (await direct(f)).p.hello([PAIR_INTENT_VOUCHED, "pair-pc-proof"])).features).toEqual([]);
  const { p } = await direct(f);
  await p.send({ type: FrameType.HELLO, flags: 0, stream_id: 0,
    payload: { protocol: "ovis-mux", versions: [1], features: [PAIR_SAS_FEATURE, PAIR_INTENT_PC, PAIR_INTENT_VOUCHED], required_features: [] } });
  expect(await sessionError(p)).toBe("protocol_error");
});

test("a PC vouched for is refused without a fresh admission for its own key, before any prompt and uncounted, even inside the pairing window", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  const otherKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])).publicKey)));
  // the owner's own pairing window invites phones, not another PC: it still needs its admission
  f.app.context.services.relay.approvals.openWindow();
  expect((await vouched(f)).refused).toBe("auth_failed");
  expect((await vouched(f, () => admit(otherKey))).refused).toBe("auth_failed");
  expect((await vouched(f, (key) => admit(key, "acct_2"))).refused).toBe("auth_failed");
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
  expect(f.app.context.services.relay.approvals.remoteList()).toEqual([]);
  for (let index = 0; index < 19; index++) f.app.context.services.devices.noteRelayFailure("vouched");
  expect(() => f.app.context.services.devices.assertRelayPairing("vouched")).not.toThrow();
});

test("a PC vouched for with an admission older than ten minutes is refused", async () => {
  const { f, admit } = await joinFixture(() => Date.now() - 11 * 60_000, true);
  expect((await vouched(f, (key) => admit(key))).refused).toBe("auth_failed");
});

test("a PC vouched for is refused by a PC with no drive account member to approve it", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  f.app.context.services.devices.update(member.id, { role: "watch" });
  expect((await vouched(f, (key) => admit(key))).refused).toBe("auth_failed");
});

test("on a PC pinned to its account's signed list, a PC vouched for is taken only when the list holds its relay key", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  const { devices, accountList, relay } = f.app.context.services;
  await signedIn(f, member);
  const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
  // the member that approves is one the list holds to drive with full power: nobody else approves on a pinned PC
  const allows = spyOn(accountList!, "allowsJoins").mockReturnValue(true);
  const asked: string[] = [];
  const inList = { holds: false };
  const holds = spyOn(accountList!, "holdsPc").mockImplementation((endpoint) => { asked.push(endpoint); return inList.holds; });
  try {
    const identity = { keys: generateKeyPair() };
    // a fresh admission of the account service is not enough any more: refused before any prompt
    expect((await askToJoin(f, (key) => admit(key), PAIR_INTENT_VOUCHED, identity)).refused).toBe("auth_failed");
    expect(asked).toEqual([bytesToHex(identity.keys.publicKey)]);
    expect(relay.approvals.remoteList()).toEqual([]);
    inList.holds = true;
    const prompt = remotePrompt(f);
    expect((await askToJoin(f, (key) => admit(key), PAIR_INTENT_VOUCHED, identity)).refused).toBeUndefined();
    expect(await prompt).toMatchObject({ vouched: true, proven_server_id: deriveServerId(identity.keys.publicKey) });
  } finally { followed.mockRestore(); allows.mockRestore(); holds.mockRestore(); }
});

test("on a pinned PC, another PC of the account is let in to watch for as long as the list holds the relay key its join proved: at its comparison, at every later sign-in, and no longer", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  const { devices, accountList } = f.app.context.services;
  const link = await signedIn(f, member);
  const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
  const allows = spyOn(accountList!, "allowsJoins").mockReturnValue(true);
  // the list holds no DEVICE under that PC's key: what it holds is the PC, by its relay key
  const role = spyOn(devices, "listRoleOf").mockReturnValue(null);
  const inList = { holds: true };
  const asked: string[] = [];
  const holds = spyOn(accountList!, "holdsPc").mockImplementation((endpoint) => { asked.push(endpoint); return inList.holds; });
  try {
    const identity = { keys: generateKeyPair() };
    const prompt = remotePrompt(f);
    const { p } = await askToJoin(f, (key) => admit(key), PAIR_INTENT_VOUCHED, identity);
    const request = await prompt;
    expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", proven_server_id: request.proven_server_id, pc_label: "Verified PC" })).status).toBe(200);
    await confirm(p);
    const admitted = await p.inbox.next();
    expect(admitted).toMatchObject({ type: FrameType.AUTH_OK, payload: { role: "watch" } });
    if (admitted.type !== FrameType.AUTH_OK) throw new Error("not let in");
    // the row keeps which PC it is: the relay key the join proved
    const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
    const row = registry.kind === "ok" ? registry.devices.find((device) => device.relay_public_key === p.publicKey) : undefined;
    expect(row).toMatchObject({ id: admitted.payload.device_id, role: "watch", vouched_pc: bytesToHex(identity.keys.publicKey) });
    // it signs in again later, and the list is asked about that relay key each time
    const pcDevice = { id: admitted.payload.device_id, keys: p.keys, publicKey: p.publicKey };
    asked.length = 0;
    const again = await relayConnection(f);
    expect(await again.auth(pcDevice)).toMatchObject({ role: "watch" });
    expect(asked).toContain(bytesToHex(identity.keys.publicKey));
    // the list removes that PC: its session ends, and it signs in no more
    inList.holds = false;
    devices.recheckListedSessions();
    expect(await bounded(again.serverError)).toBe("auth_revoked");
    // refused by name, not left unanswered
    const refused = await relayConnection(f);
    void refused.auth(pcDevice).catch(() => undefined);
    expect(await bounded(refused.serverError)).toBe("auth_failed");
  } finally { followed.mockRestore(); allows.mockRestore(); role.mockRestore(); holds.mockRestore(); }
});

test("on a pinned PC, a PC vouched for whose relay key the list removed while its comparison waited is not taken: no row, no session", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  const { devices, accountList } = f.app.context.services;
  const link = await signedIn(f, member);
  const followed = spyOn(devices, "listFollowed").mockReturnValue(true);
  // the member that approves is one the list holds to drive with full power: nobody else approves on a pinned PC
  const allows = spyOn(accountList!, "allowsJoins").mockReturnValue(true);
  const inList = { holds: true };
  const holds = spyOn(accountList!, "holdsPc").mockImplementation(() => inList.holds);
  try {
    const identity = { keys: generateKeyPair() };
    const prompt = remotePrompt(f);
    const { p } = await askToJoin(f, (key) => admit(key), PAIR_INTENT_VOUCHED, identity);
    const request = await prompt;
    // its removal reaches this PC while the member has not answered yet
    inList.holds = false;
    expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", proven_server_id: request.proven_server_id, pc_label: "Verified PC" })).status).toBe(200);
    await confirm(p);
    const answer = await p.inbox.next();
    expect([answer.type, answer.type === FrameType.SESSION_ERROR ? answer.payload.code : null]).toEqual([FrameType.SESSION_ERROR, "auth_failed"]);
    const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
    expect(registry.kind === "ok" && registry.devices.some((row) => row.relay_public_key === p.publicKey)).toBe(false);
  } finally { followed.mockRestore(); allows.mockRestore(); holds.mockRestore(); }
});

test("a PC vouched for waits for a member as 'pair this PC', and an approval makes a watch row the approver added, no member", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  const link = await signedIn(f, member);
  const prompt = remotePrompt(f);
  const { p } = await vouched(f, (key) => admit(key));
  const request = await prompt;
  // the approver's app is asked to pair this PC only, so it signs no add and introduces nothing
  expect(request).toMatchObject({ label: request.proven_server_id, intent: "pc", vouched: true, key: p.publicKey });
  expect(f.app.context.services.relay.approvals.list()).toEqual([]);
  expect(f.app.context.services.relay.approvals.decide(request.id, true)).toBe(false);
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", proven_server_id: request.proven_server_id, pc_label: "Verified PC" })).status).toBe(200);
  await confirm(p);
  expect((await p.inbox.next()).type).toBe(FrameType.AUTH_OK);
  const registry = readDeviceRegistry(join(f.stateDir, "devices.json"));
  const row = registry.kind === "ok" ? registry.devices.find((device) => device.relay_public_key === p.publicKey) : undefined;
  expect(row).toMatchObject({ label: "Verified PC", role: "watch", added_by: member.id });
  expect(row).not.toHaveProperty("account");
  expect(row).not.toHaveProperty("account_add");
});

test("a legacy digit answer for a proven PC counts on its own path only", async () => {
  const { f, member, admit } = await joinFixture(Date.now, true);
  const link = await signedIn(f, member);
  for (let failure = 0; failure < 19; failure++) f.app.context.services.devices.noteRelayFailure("vouched");
  const prompt = remotePrompt(f);
  const { p, digits } = await vouched(f, (key) => admit(key));
  const request = await prompt;
  expect(request.choices).toEqual([]);
  expect((await post(link, "/api/relay/pairing", { id: request.id, decision: "approve", digits })).body.error?.code).toBe("wrong_digits");
  expect(await sessionError(p)).toBe("auth_failed");
  expect(f.app.context.services.devices.hasKey(p.publicKey)).toBe(false);
  expect(() => f.app.context.services.devices.assertRelayPairing("vouched")).toThrow();
  expect(() => f.app.context.services.devices.assertRelayPairing("account")).not.toThrow();
  expect(() => f.app.context.services.devices.assertRelayPairing("code")).not.toThrow();
});

test("PCs vouched for share the account joins' five a minute", async () => {
  const { f, admit } = await joinFixture(Date.now, true);
  for (let index = 0; index < 5; index++) expect(f.app.context.services.relay.approvals.takeAccountJoin()).toBe(true);
  const { p } = await vouched(f, key => admit(key));
  expect(await sessionError(p)).toBe("auth_failed");
});

async function memberSocket(f: Fixture, device: Awaited<ReturnType<typeof relayDevice>>) {
  const link = await relayConnection(f, { websocket: f.app.context.services.core.socketHandlers });
  await link.auth(device);
  const socket = link.openSocket();
  await socket.opened;
  socket.send({ type: "machine-events", enabled: true });
  return socket;
}

const remotePairings = (count: number) => (message: { type: string; event?: { type: string; pairings?: unknown[] } }) =>
  message.type === "machine-event" && message.event?.type === "remote-pairings" && message.event.pairings?.length === count;

test("a drive account member's machine-event socket is told of account joins waiting for it, with their key", async () => {
  const { f, member } = await accountFixture();
  const socket = await memberSocket(f, member);
  await socket.until(remotePairings(0) as never);
  f.app.context.services.relay.approvals.ask("Mac app", "123456", Date.now() + 90_000, { intent: "account", key: member.publicKey, deviceId: "00112233445566aa" });
  const shown = await socket.until(remotePairings(1) as never) as unknown as { event: { pairings: { key: string; choices: string[] }[] } };
  expect(shown.event.pairings[0]?.key).toBe(member.publicKey);
  expect(shown.event.pairings[0]?.choices).toContain("123456");
});

test("a watching account member's machine-event socket hears of no account join", async () => {
  const { f, member } = await accountFixture("watch");
  const socket = await memberSocket(f, member);
  // the subscription is live once a window that may not approve is told no relay pairing waits
  await socket.until(((message: { type: string; event?: { type: string } }) => message.type === "machine-event" && message.event?.type === "relay-pairings") as never);
  f.app.context.services.relay.approvals.ask("Mac app", "123456", Date.now() + 90_000, { intent: "account", key: member.publicKey, deviceId: "00112233445566aa" });
  await relayDevice(f);
  await socket.until(((message: { type: string; event?: { type: string } }) => message.type === "machine-event" && message.event?.type === "device-paired") as never);
  expect(socket.messages.some((message) => remotePairings(1)(message as never))).toBe(false);
});

test("what a PC's own add-me screen lets in is decided on that PC only, never by an account member", async () => {
  const { f, member } = await accountFixture();
  const approvals = f.app.context.services.relay.approvals;
  approvals.openWindow(Date.now(), { localOnly: true });
  const asked = approvals.ask("New phone", "123456", Date.now() + 90_000, { intent: "pc", key: member.publicKey, deviceId: "00112233445566aa" });
  if (!asked) throw new Error("no room to ask");
  const id = approvals.list()[0]!.id;
  expect(approvals.remoteList()).toEqual([]);
  expect(approvals.decideRemote(id, true, "123456", { id: member.id, label: "Account phone", role: "drive" })).toEqual({ outcome: "gone" });
  expect(approvals.decide(id, true)).toBe(true);
  expect(await asked.decision).toEqual({ approved: true });
});

test("a comparison asked under the add-me screen stays the PC's own even when that screen's window closes before its digits show", async () => {
  const { f } = await accountFixture();
  const approvals = f.app.context.services.relay.approvals;
  approvals.openWindow(Date.now(), { localOnly: true });
  const { p } = await direct(f);
  await p.hello([PAIR_SAS_FEATURE, PAIR_INTENT_PC]);
  const nonce = randomPairNonce();
  await p.send({ type: FrameType.PAIR_REQUEST, flags: 0, stream_id: 0, payload: { label: "New phone", public_key: p.publicKey, commitment: toBase64Url(pairCommitment(p.binding(), p.publicKey, nonce)) } });
  expect((await p.inbox.next()).type).toBe(FrameType.PAIR_CHALLENGE);
  approvals.openWindow(Date.now() - 60 * 60_000, { localOnly: true });
  const listed = deferred<void>();
  const stop = approvals.subscribe((list) => { if (list.length > 0) listed.resolve(); });
  await p.send({ type: FrameType.PAIR_REVEAL, flags: 0, stream_id: 0, payload: { nonce: toBase64Url(nonce) } });
  await bounded(listed.promise).finally(stop);
  expect(approvals.remoteList()).toEqual([]);
});
