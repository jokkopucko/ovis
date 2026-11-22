/**
 * A PC for the pairing tests of this folder: the server on a state folder of its own and a free port, the test
 * account service, and its relay turned on over a socket that never opens, so codes are made as on a PC whose relay
 * is connecting and nothing leaves this process. Its owner's calls go over HTTP as the app's own controls do;
 * devices come through the relay's test harness (server/relay/test-helpers.ts).
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportAccountKey, newRecordId, signAccountRecord } from "../../shared/account-records.ts";
import { FakeAccountService } from "../../shared/account-service-fake.ts";
import { importPublicKey } from "../../shared/relay-e2ee.ts";
import type { HttpRequest } from "../../shared/relay-mux-engine.ts";
import { FrameType, KEY_PROOF_FEATURE, type MuxFrame, type SessionError } from "../../shared/relay-mux.ts";
import { pairFingerprint, signPairProof } from "../../shared/pair-fingerprint.ts";
import { decodeOffer } from "../../shared/relay-offer.ts";
import { readDeviceRegistry } from "../devices.ts";
import { createServer } from "../index.ts";
import { RelayService } from "../relay/service.ts";
import { bounded, deferred, relayConnection, TestClock } from "../relay/test-helpers.ts";
import { registerSnapshotPc } from "./listed-pc.test-helpers.ts";

/** The relay id the harness's sessions sign in to (relayConnection), which a link names. */
export const SERVER_ID = "0123456789abcdef0123456789abcdef";

function idleSocket(): WebSocket {
  return Object.assign(new EventTarget(), { binaryType: "arraybuffer", readyState: 0, send() {}, close() {}, onopen: null, onmessage: null, onerror: null, onclose: null }) as unknown as WebSocket;
}

export interface Body {
  error?: { code: string; message: string };
  url?: string;
  code?: string;
  account?: string | null;
  members?: number;
  unlinked?: string[];
  blocked?: string[];
  cancelled?: boolean;
  devices?: { id: string; label: string; role: string; account?: string }[];
  [field: string]: unknown;
}

export interface Answer { status: number; headers: Headers; body: Body }

export type Pc = Awaited<ReturnType<typeof pairingPc>>;

/** Establish standing for a bound member before it signs in or signs a record. */
export async function firstPairingRead(pc: Pc): Promise<void> {
  pc.account.opensAll = true;
  await registerSnapshotPc(pc.account, pc, pc.app.context.services.relay.currentIdentity());
  const read = await pc.app.context.services.accountMailbox.readSnapshot();
  if (!read?.committed) throw new Error("The member fixture did not commit its first whole read");
}
export type Link = Awaited<ReturnType<typeof relayConnection>>;
type SessionOptions = Parameters<typeof relayConnection>[1];

export interface Phone { keys: CryptoKeyPair; spki: string }

/** A device's key: the one it pairs and signs in with, which a signed-in app's is its account key. */
export async function phone(): Promise<Phone> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  return { keys, spki: await exportAccountKey(keys.publicKey) };
}

/** A drive member of `account` as devices.json holds one: written before a PC starts (`rows`), it makes that PC one in the account. */
export async function memberRow(account: string) {
  const key = await phone();
  const row = { id: randomBytes(8).toString("hex"), label: "Account phone", role: "drive", token_hash: randomBytes(32).toString("hex"),
    relay_public_key: key.spki, account, created_at: new Date().toISOString(), last_seen_at: null };
  return { row, key };
}

/**
 * `accountFetch`: what the PC's calls to the account service reach, given the test account service; that service
 * itself by default. `accountService`: OVIS_ACCOUNT_SERVICE_URL's value (`off` turns it off). `server`: further options
 * of createServer.
 */
export async function pairingPc(options: { rows?: readonly { created_at: string }[]; accountFetch?: (request: Request, service: FakeAccountService) => Promise<Response>; accountService?: string; server?: Partial<Parameters<typeof createServer>[0]>; prepare?: (stateDir: string) => void; startRelay?: boolean } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "ovis-pairing-"));
  const first = options.rows?.[0];
  if (first) writeFileSync(join(stateDir, "devices.json"), JSON.stringify({ gate_closed_at: first.created_at, devices: options.rows }), { mode: 0o600 });
  options.prepare?.(stateDir);
  const account = new FakeAccountService();
  const accountFetch = options.accountFetch;
  const service = new RelayService({ stateDir, relay: "wss://relay.test", connect: () => idleSocket() });
  const app = createServer({ ...options.server, port: 0, hostname: "127.0.0.1", stateDir, token: options.server?.token ?? "", tailscaleOwner: null, sidecar: false, relay: service,
    accountService: { url: options.accountService ?? "https://account.test", fetch: accountFetch ? (request) => accountFetch(request, account) : account.fetch } });
  const base = `http://127.0.0.1:${app.port}`;
  const closes: (() => void)[] = [];
  /** A call from this PC itself: its own origin, and no credential. */
  const local = async (path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Answer> => {
    const response = await fetch(base + path, {
      method: init.method ?? "GET",
      headers: { origin: base, ...(init.body === undefined ? {} : { "content-type": "application/json" }), ...init.headers },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text === "" ? {} : JSON.parse(text) as Body };
  };
  const relayControl = (path: string, headers: Record<string, string> = {}) => local(path, { method: "POST", headers: { "x-herdr-update": "1", ...headers } });
  const offered = async (headers: Record<string, string> = {}): Promise<string> => {
    const offer = await relayControl("/api/relay/offer", headers);
    const code = typeof offer.body.url === "string" ? decodeOffer(offer.body.url)?.code : undefined;
    if (offer.status !== 200 || code === undefined) throw new Error(`The offer gave no code: ${offer.status} ${JSON.stringify(offer.body)}`);
    return code;
  };
  if (options.startRelay !== false) {
    const started = await relayControl("/api/relay/start");
    if (started.status !== 200) throw new Error(`The relay did not start: ${JSON.stringify(started.body)}`);
  }
  return {
    stateDir, app, closes, local, account,
    devices: app.context.services.devices,
    /** The code of the relay tab's QR code: POST /api/relay/offer with `x-ovis-no-account-only`, on a PC an account was named for (setUpFor). */
    tabCode: () => offered({ "x-ovis-no-account-only": "1" }),
    /** The code of an offer asked for with no header and with no pairing started first: the first-run guide's QR code, a phone's Connect another device. */
    offerCode: () => offered(),
    /** The code `ovis pair` shows: a pairing started on this PC, carried by a relay offer asked for with no header. */
    async startedCode(): Promise<string> {
      const pairing = await local("/api/devices/pair/start", { method: "POST", headers: { "x-herdr-machine": "1" }, body: {} });
      if (pairing.status !== 200) throw new Error(`No pairing was started: ${pairing.status} ${JSON.stringify(pairing.body)}`);
      return offered();
    },
    status: async () => (await local("/api/account/status")).body,
    listed: async () => (await local("/api/devices")).body.devices ?? [],
    stored: () => {
      const registry = readDeviceRegistry(join(stateDir, "devices.json"));
      return registry.kind === "ok" ? registry.devices : [];
    },
    async close() {
      for (const end of closes.splice(0)) end();
      await service.shutdown();
      app.stop();
      rmSync(stateDir, { recursive: true, force: true });
    },
  };
}

/**
 * The call a command or page of this PC makes once its owner has signed in: it names the account the PC is for
 * (POST /api/account/relay-account). The relay tab's code is made only once one is named.
 */
export async function setUpFor(pc: Pc, account: string): Promise<void> {
  const named = await pc.local("/api/account/relay-account", { method: "POST", headers: { "x-herdr-machine": "1" }, body: { account } });
  if (named.status !== 204) throw new Error(`The account was not named: ${named.status} ${JSON.stringify(named.body)}`);
}

/**
 * What an app signed in to `account` does before it pairs with a code whose offer carries the mark: it lists the PC in
 * its account and posts an admission for `device`'s key at it, quiet or ringing (docs/account.md, "The account's word").
 * `server`: the PC it names, this one by default. On a PC whose clock a test moves by hand, that clock is moved on to
 * when the PC may next read the account service, so a link sent after this is judged at once.
 */
export async function vouchFor(pc: Pc, account: string, device: Phone, options: { quiet?: boolean; server?: { server_id: string; public_key: string } } = {}): Promise<void> {
  const identity = options.server ?? pc.app.context.services.relay.currentIdentity();
  if (!identity) throw new Error("The PC has no relay identity");
  const token = pc.account.issueToken(account);
  const call = (path: string, method: string, body: unknown) =>
    pc.account.fetch(new Request(`https://account.test${path}`, { method, headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) }));
  const listed = await call(`/v1/pcs/${identity.server_id}`, "PUT", { label: "PC", public_key: bytesToHex(importPublicKey(identity.public_key)), relay: "wss://relay.ovis.sh" });
  if (!listed.ok) throw new Error(`The PC was not listed: ${listed.status} ${await listed.text()}`);
  const posted = await call("/v1/admissions", "POST", { server_id: identity.server_id, label: "Phone", key: device.spki, ...(options.quiet === undefined ? {} : { quiet: options.quiet }) });
  if (!posted.ok) throw new Error(`The admission was refused: ${posted.status} ${await posted.text()}`);
  untilNextRead(pc);
}

/** On a PC whose clock a test moves by hand: moves it on to when the PC may next read the account service. */
export function untilNextRead(pc: Pc): void {
  const clock = pc.devices.waitClock();
  if (clock instanceof TestClock) clock.advance(pc.app.context.services.accountMailbox.serviceRetryMs());
}

/** Resolves when the PC next asks the account service about a link's key: that link is waiting for its word. */
export function nextAsk(pc: Pc): Promise<void> {
  const mailbox = pc.app.context.services.accountMailbox;
  const vouch = mailbox.vouch;
  return bounded(new Promise<void>((resolve) => {
    mailbox.vouch = (...args) => {
      mailbox.vouch = vouch;
      const answer = vouch.apply(mailbox, args);
      resolve();
      return answer;
    };
  }));
}

/**
 * PAIR with `code` as a device that names `device`'s key: the row id and the role its answer gave, with the session
 * that paired; or the error the PC ended the session with.
 */
export async function pair(pc: Pc, code: string, device: Phone, options: SessionOptions = {}): Promise<{ id: string; role: string; link: Link } | { error: SessionError }> {
  const link = await relayConnection(pc, options);
  const payload = await link.pair(code, device.spki).then((admitted) => admitted, () => null);
  if (payload === null) return { error: await bounded(link.serverError) };
  return { id: payload.device_id, role: payload.role, link };
}

/** AUTH as the row `id` with `device`'s key, on a connection of its own: the session, or the error the PC ended it with. */
export async function signIn(pc: Pc, id: string, device: Phone, options: SessionOptions = {}, features: readonly string[] = []): Promise<{ link: Link; role: string; direct: readonly string[] | undefined } | { error: SessionError }> {
  const link = await relayConnection(pc, options);
  const payload = await link.auth({ id, keys: device.keys, publicKey: device.spki }, features).then((admitted) => admitted, () => null);
  if (payload === null) return { error: await bounded(link.serverError) };
  return { link, role: payload.role, direct: payload.direct };
}

/**
 * A device that paired with `code` and signed in on a connection of its own, as the app does before its account
 * steps: `pairing` is the session its PAIR made, `session` the one that proved its key by AUTH.
 */
export async function signedInWith(pc: Pc, code: string, key?: Phone, options: SessionOptions = {}) {
  const device = key ?? await phone();
  const made = await pair(pc, code, device, options);
  if ("error" in made) throw new Error(`The pairing was refused: ${made.error}`);
  const session = await signIn(pc, made.id, device, options);
  if ("error" in session) throw new Error(`The sign-in was refused: ${session.error}`);
  return { id: made.id, key: device, role: made.role, pairing: made.link, session: session.link };
}

/** A link that makes the row `id` a member of `account`: it moves the row from `from` to `to` (the same key keeps it). */
export function linkRecord(id: string, account: string, from: Phone, to: Phone = from) {
  return signAccountRecord({ v: 1, kind: "link", account, key: to.spki, server_id: SERVER_ID, device_id: id, old_key: from.spki,
    issued_at: new Date().toISOString(), id: newRecordId(), signer: to.spki }, to.keys.privateKey);
}

const guard = [["content-type", "application/json"], ["x-herdr-machine", "1"]] as const;

export async function ask(link: Link, target: string, init: { method?: HttpRequest["method"]; body?: unknown } = {}): Promise<Answer> {
  const request = link.open(target, { method: init.method ?? "GET", headers: init.body === undefined ? [] : guard, body: init.body === undefined ? "none" : "stream" });
  if (init.body !== undefined) void request.stream.sendBody(new Blob([JSON.stringify(init.body)]).stream()).catch(() => {});
  const response = await request.response;
  const text = await response.text();
  return { status: response.status, headers: response.headers, body: text === "" ? {} : JSON.parse(text) as Body };
}

export function sendLink(link: Link, record: unknown): Promise<Answer> {
  return ask(link, "/api/account/link", { method: "POST", body: { record } });
}

export function ended(link: Link): Promise<SessionError> {
  return bounded(link.serverError);
}

/** A device that offers the proof: it pairs, answers the challenge, and reports what it saw. */
export async function provingDevice(made: Pc, code: string) {
  const device = await phone();
  const link = await relayConnection(made);
  const challenge = deferred<string>();
  const pending = deferred<MuxFrame>();
  link.onFrame = (frame) => {
    if (frame.type === FrameType.KEY_CHALLENGE) challenge.resolve(frame.payload.challenge);
    if (frame.type === FrameType.KEY_PENDING) pending.resolve(frame);
  };
  await link.hello([KEY_PROOF_FEATURE]);
  link.mux.sendSession({ type: FrameType.PAIR, flags: 0, stream_id: 0, payload: { code, label: "New phone", public_key: device.spki } });
  const sent = await bounded(challenge.promise);
  link.mux.sendSession({ type: FrameType.KEY_PROVE, flags: 0, stream_id: 0, payload: { signature: await signPairProof(SERVER_ID, sent, device.spki, device.keys.privateKey) } });
  return { device, link, challenge: sent, pending: bounded(pending.promise), fingerprint: await pairFingerprint(SERVER_ID, sent, device.spki) };
}
