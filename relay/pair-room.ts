/**
 * The PC holds the room for a nameplate (`host`); a device that typed the code joins it (`guest`),
 * one at a time. The two run CPace through it; the relay reads none of it and is not trusted to
 * keep any limit: the PC counts tries itself. These limits only stop abuse through an honest relay.
 *
 * Every guest gets a random attempt id. The host hears `{"type":"guest","attempt"}` and
 * `{"type":"gone","attempt"}`; a guest's binary frame reaches the host prefixed with its attempt
 * id, and a host's binary frame must start with the current guest's id, which is stripped (a frame
 * for an attempt that is over goes nowhere). `{"type":"drop","attempt"}` from the host ends that
 * guest only. A guest's text is never passed on. What each socket is lives in its own info, so a
 * Durable Object evicted between frames picks up as it was.
 *
 * A host may offer its PC's key (`&server_id=<32 hex>&public_key=<64 hex>`): it then answers a server
 * challenge for role `pair-host` and the nameplate (shared/relay-server-proof.ts) before it holds the
 * nameplate, and while it proves no device finds the code and no other host takes it. A relay that
 * asks for relay passes (pass.ts) lets in, while enforced, only a host whose pass holds for the key
 * it offers, and a host keeps its nameplate only while that holds: once passes are enforced (grace
 * reached its date) and its pass, if any, ran out, it closes 4402, its guest with it. The device that
 * joins never needs a pass.
 */
import { IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, WIRE_VERSION, passRefusal, type Frame } from "./core.ts";
import { RELAY_PASS_CLOSE, RELAY_PASS_EXPIRED, RELAY_PASS_INVALID, RELAY_PASS_REQUIRED, RELAY_PASS_SKEW_S } from "../shared/relay-pass.ts";
import { SERVER_KEY_INVALID, SERVER_KEY_MISMATCH, SERVER_PROOF_CLOSE, SERVER_PROOF_MS, deriveServerId, proofKey, serverChallenge, verifyServerProof } from "../shared/relay-server-proof.ts";
import { passMode, type PassPolicy, type PassResult } from "./pass.ts";

export const ATTEMPT_BYTES = 16;

export const PAIR_CLOSE = {
  NO_HOST: 4404,
  TAKEN: 4409,
  BUSY: 1013,
  DROPPED: 1000,
  HOST_GONE: 1001,
  EXPIRED: 1001,
  POLICY: 1008,
  TOO_BIG: 1009,
} as const;

/** the public part of a typed code: three Crockford base32 characters */
export const NAMEPLATE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{3}$/;
export const PAIR_MAX_FRAME = 4096;
/** a host's room lasts at most this long: a code lives 10 minutes */
export const PAIR_HOST_MS = 11 * 60_000;
export const PAIR_GUEST_MS = 30_000;
/** guests a room takes in its life: the PC's three tries and some that drop before trying */
export const PAIR_GUESTS_PER_ROOM = 12;
export const PAIR_GUEST_GAP_MS = 2000;

export interface PairSocketRequest {
  kind: "pair";
  nameplate: string;
  role: "host" | "guest";
  version: string | null;
  /** the PC key a host offers, which it proves before it holds the nameplate */
  key?: { server_id: string; public_key: string };
  pass?: PassResult;
}

export function parsePairRequest(url: URL): PairSocketRequest | { error: string } {
  const nameplate = url.searchParams.get("nameplate") ?? "";
  if (!NAMEPLATE_PATTERN.test(nameplate)) return { error: "nameplate must be 3 Crockford base32 characters" };
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "guest") return { error: "role must be host or guest" };
  const request: PairSocketRequest = { kind: "pair", nameplate, role, version: url.searchParams.get("v") };
  const serverId = url.searchParams.get("server_id");
  const publicKey = url.searchParams.get("public_key");
  if (role === "guest" || (serverId === null && publicKey === null)) return request;
  if (!serverId || !/^[0-9a-f]{32}$/.test(serverId) || !publicKey || !/^[0-9a-f]{64}$/.test(publicKey)) return { error: "server_id and public_key must be 32 and 64 lowercase hex digits" };
  return { ...request, key: { server_id: serverId, public_key: publicKey } };
}

export interface PairInfo {
  pair: "host" | "guest";
  attempt?: string;
  deadline: number;
  seen: number;
  guests?: number;
  lastGuest?: number;
  /** a host still proving its PC key: it holds no nameplate until it answers (its deadline is `expires`) */
  proof?: { expected: string; expires: number };
  /** a host let in with a pass that holds: when it expires (ms), its key id and the server_id it is for, re-checked against the relay's current keys and revocations */
  pass_exp?: number;
  pass_kid?: string;
  server_id?: string;
  ended?: true;
}

type HostPass = Required<Pick<PairInfo, "pass_exp" | "pass_kid" | "server_id">>;

/** how long after its pass's expiry a host keeps its nameplate, for clocks that differ */
const PASS_SKEW_MS = RELAY_PASS_SKEW_S * 1000;

export function isPairInfo(value: unknown): value is PairInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  const proof = info["proof"] as Record<string, unknown> | undefined;
  return (info["pair"] === "host" || info["pair"] === "guest") && typeof info["deadline"] === "number" && typeof info["seen"] === "number"
    && (proof === undefined || (typeof proof === "object" && proof !== null && typeof proof["expected"] === "string" && typeof proof["expires"] === "number"))
    && (info["pass_exp"] === undefined || typeof info["pass_exp"] === "number")
    && (info["pass_kid"] === undefined || typeof info["pass_kid"] === "string")
    && (info["server_id"] === undefined || typeof info["server_id"] === "string")
    && (info["attempt"] === undefined || (typeof info["attempt"] === "string" && /^[0-9a-f]{32}$/.test(info["attempt"])))
    && (info["guests"] === undefined || typeof info["guests"] === "number")
    && (info["lastGuest"] === undefined || typeof info["lastGuest"] === "number")
    && (info["ended"] === undefined || info["ended"] === true);
}

export interface PairRoomHost<S extends object> {
  sockets(): Iterable<S>;
  info(socket: S): PairInfo | null;
  setInfo(socket: S, info: PairInfo): void;
  send(socket: S, frame: Frame): void;
  close(socket: S, code: number, reason: string): void;
  wake?(at: number): void;
  /** when the platform last answered this socket's keepalive by itself, if it does (Cloudflare) */
  keepaliveAt?(socket: S): number | null;
  now(): number;
  /** the relay pass policy; without it every host is let in, as before */
  readonly pass?: PassPolicy;
}

const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOf = (frame: Frame): Uint8Array | null => typeof frame === "string" ? null : frame instanceof Uint8Array ? frame : new Uint8Array(frame);
const sizeOf = (frame: Frame) => typeof frame === "string" ? new TextEncoder().encode(frame).length : frame.byteLength;

export class PairRoom<S extends object> {
  private readonly ended = new WeakSet<S>();

  constructor(private readonly host: PairRoomHost<S>, private readonly guestGapMs = PAIR_GUEST_GAP_MS) {}

  private peers(): { socket: S; info: PairInfo }[] {
    const out: { socket: S; info: PairInfo }[] = [];
    for (const socket of this.host.sockets()) {
      if (this.ended.has(socket)) continue;
      const info = this.host.info(socket);
      if (info && !info.ended) out.push({ socket, info });
    }
    return out;
  }

  private find(pair: "host" | "guest", except?: S) { return this.peers().find((peer) => peer.info.pair === pair && peer.socket !== except); }

  owns(socket: S): boolean {
    return this.host.info(socket) !== null;
  }

  /** Why a host may no longer hold (or prove for) its nameplate: passes are enforced and no pass of its holds. Null while it may. */
  private lapsed(info: PairInfo, now: number): string | null {
    const policy = this.host.pass;
    if (!policy || info.pair !== "host" || passMode(policy, now) !== "enforce") return null;
    if (info.pass_exp === undefined) return RELAY_PASS_REQUIRED;
    // a pass under a key the relay no longer trusts, or for a PC it revoked since, holds no longer.
    // A host the version before this check admitted kept no key id or server_id (hibernated sockets
    // outlive a deploy), so neither check can name it. Any revocation in the current settings may be
    // its PC, so it closes rather than guess and re-admits through the check that follows; a key
    // removed from them it cannot be matched against at all, so its pass's expiry and hold()'s
    // deadline of PAIR_HOST_MS (11 minutes) are what hold it otherwise.
    if (info.pass_kid === undefined) {
      if (policy.revoked.size > 0) return RELAY_PASS_INVALID;
      return now < info.pass_exp + PASS_SKEW_MS ? null : RELAY_PASS_EXPIRED;
    }
    if (!policy.keys.has(info.pass_kid) || info.server_id === undefined || policy.revoked.has(info.server_id)) return RELAY_PASS_INVALID;
    return now < info.pass_exp + PASS_SKEW_MS ? null : RELAY_PASS_EXPIRED;
  }

  /** When `lapsed` may next change for a host: the start of enforcement (whatever its pass, which nothing checks before), or once enforced its pass running out. */
  private passDue(info: PairInfo, now: number): number {
    const policy = this.host.pass;
    if (!policy || policy.mode === "off" || info.pair !== "host") return Infinity;
    if (passMode(policy, now) !== "enforce") return policy.enforceAt ?? Infinity;
    return info.pass_exp === undefined ? Infinity : info.pass_exp + PASS_SKEW_MS;
  }

  /** Closes the room's host 4402 when its pass no longer lets it hold the nameplate (its guest goes with it), whatever the sweep's timing. */
  private endLapsedHost(now: number): void {
    const host = this.find("host");
    const why = host ? this.lapsed(host.info, now) : null;
    if (host && why !== null) this.end(host.socket, RELAY_PASS_CLOSE, why);
  }

  private placeHost(socket: S, info: PairInfo, now: number): void {
    this.host.setInfo(socket, info);
    this.host.wake?.(info.deadline);
    const due = this.passDue(info, now);
    if (due < info.deadline) this.host.wake?.(due);
  }

  end(socket: S, code: number, reason: string): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    if (info) this.host.setInfo(socket, { ...info, ended: true });
    this.host.close(socket, code, reason);
    this.finish(socket, info);
  }

  open(socket: S, request: PairSocketRequest): void {
    const now = this.host.now();
    // the host already there goes first if its pass no longer holds, before this socket is any part of the room
    this.endLapsedHost(now);
    this.host.setInfo(socket, { pair: request.role, deadline: now, seen: now });
    if (request.version !== WIRE_VERSION) return this.end(socket, PAIR_CLOSE.POLICY, "unsupported wire version");
    if (request.role === "host") {
      const refused = passRefusal(request, this.host.pass, now);
      if (refused !== null) return this.end(socket, RELAY_PASS_CLOSE, refused);
      // a host still proving counts: one at a time may try for a nameplate
      if (this.find("host", socket)) return this.end(socket, PAIR_CLOSE.TAKEN, "this code is in use");
      const pass: HostPass | undefined = request.pass?.state === "ok" && request.pass.exp !== undefined && request.pass.kid !== undefined && request.key
        ? { pass_exp: request.pass.exp, pass_kid: request.pass.kid, server_id: request.key.server_id } : undefined;
      if (!request.key) return this.hold(socket, now, pass);
      const key = proofKey(request.key.public_key);
      if (!key || deriveServerId(key) !== request.key.server_id) return this.end(socket, SERVER_PROOF_CLOSE, SERVER_KEY_MISMATCH);
      let challenge: ReturnType<typeof serverChallenge>;
      // the proof covers this nameplate, so it opens no other rendezvous and no PC socket
      try { challenge = serverChallenge(key, { server_id: request.key.server_id, role: "pair-host", connection_id: request.nameplate }); }
      catch { return this.end(socket, SERVER_PROOF_CLOSE, SERVER_KEY_INVALID); } // a low-order X25519 point
      const expires = now + SERVER_PROOF_MS;
      this.placeHost(socket, { pair: "host", deadline: expires, seen: now, proof: { expected: challenge.expected, expires }, ...pass }, now);
      this.host.send(socket, challenge.frame);
      return;
    }
    const host = this.find("host");
    if (!host || host.info.proof) return this.end(socket, PAIR_CLOSE.NO_HOST, "no PC shows this code");
    if (this.find("guest", socket)) return this.end(socket, PAIR_CLOSE.BUSY, "another device is trying this code");
    const guests = host.info.guests ?? 0;
    if (guests >= PAIR_GUESTS_PER_ROOM || now - (host.info.lastGuest ?? -Infinity) < this.guestGapMs) return this.end(socket, PAIR_CLOSE.BUSY, "too many tries for this code");
    this.host.setInfo(host.socket, { ...host.info, guests: guests + 1, lastGuest: now });
    const attempt = toHex(crypto.getRandomValues(new Uint8Array(ATTEMPT_BYTES)));
    const deadline = now + PAIR_GUEST_MS;
    this.host.setInfo(socket, { pair: "guest", attempt, deadline, seen: now });
    this.host.wake?.(deadline);
    this.host.send(host.socket, JSON.stringify({ type: "guest", attempt }));
  }

  private hold(socket: S, now: number, pass: HostPass | undefined): void {
    this.placeHost(socket, { pair: "host", deadline: now + PAIR_HOST_MS, seen: now, guests: 0, ...pass }, now);
    this.host.send(socket, JSON.stringify({ type: "waiting" }));
  }

  message(socket: S, frame: Frame): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (!info || info.ended) return;
    if (sizeOf(frame) > PAIR_MAX_FRAME) return this.end(socket, PAIR_CLOSE.TOO_BIG, "frame too big");
    const now = this.host.now();
    // the host's pass stopped letting it hold the nameplate since the last sweep: it goes before this frame does anything
    this.endLapsedHost(now);
    if (this.ended.has(socket)) return;
    // a host proving its key: its first frame is the answer, compared in constant time; anything else, or late, is refused
    if (info.proof) {
      if (now >= info.proof.expires || !verifyServerProof(frame, info.proof.expected)) return this.end(socket, SERVER_PROOF_CLOSE, "invalid or expired server proof");
      const { pass_exp, pass_kid, server_id } = info;
      return this.hold(socket, now, pass_exp !== undefined && pass_kid !== undefined && server_id !== undefined ? { pass_exp, pass_kid, server_id } : undefined);
    }
    // past its deadline a socket passes nothing on, whenever the next sweep comes
    if (now >= info.deadline) return this.end(socket, PAIR_CLOSE.EXPIRED, "time ran out");
    this.host.setInfo(socket, { ...info, seen: now });
    if (frame === KEEPALIVE_PING) return this.host.send(socket, KEEPALIVE_PONG);
    const bytes = bytesOf(frame);
    if (info.pair === "guest") {
      const host = this.find("host");
      if (bytes === null || !host || info.attempt === undefined) return;
      const out = new Uint8Array(ATTEMPT_BYTES + bytes.length);
      out.set(Uint8Array.from(info.attempt.match(/../g)!, (pair) => Number.parseInt(pair, 16)));
      out.set(bytes, ATTEMPT_BYTES);
      return this.host.send(host.socket, out);
    }
    const guest = this.find("guest");
    if (bytes === null) {
      let message: unknown;
      try { message = JSON.parse(frame as string); } catch { return; }
      if (typeof message !== "object" || message === null || Array.isArray(message)) return;
      const drop = message as { type?: unknown; attempt?: unknown };
      if (drop.type === "drop" && guest && drop.attempt === guest.info.attempt) this.end(guest.socket, PAIR_CLOSE.DROPPED, "the PC ended this try");
      return;
    }
    if (!guest || bytes.length < ATTEMPT_BYTES || toHex(bytes.subarray(0, ATTEMPT_BYTES)) !== guest.info.attempt) return;
    this.host.send(guest.socket, bytes.slice(ATTEMPT_BYTES));
  }

  closed(socket: S): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    if (info?.ended) { this.ended.add(socket); return; }
    this.finish(socket, info);
  }

  private finish(socket: S, info: PairInfo | null): void {
    this.ended.add(socket);
    if (!info) return;
    if (info.pair === "guest") {
      const host = this.find("host");
      if (host && info.attempt !== undefined) this.host.send(host.socket, JSON.stringify({ type: "gone", attempt: info.attempt }));
      return;
    }
    // a refused second host is no host of this room: the one that holds it stays
    if (this.find("host")) return;
    for (const peer of this.peers()) if (peer.info.pair === "guest") this.end(peer.socket, PAIR_CLOSE.HOST_GONE, "the PC is gone");
  }

  sweep(): number | null {
    const now = this.host.now();
    this.endLapsedHost(now);
    let next: number | null = null;
    for (const peer of this.peers()) {
      const seen = Math.max(peer.info.seen, this.host.keepaliveAt?.(peer.socket) ?? 0);
      if (now >= peer.info.deadline || now - seen >= IDLE_MS) {
        if (peer.info.proof) this.end(peer.socket, SERVER_PROOF_CLOSE, "server proof timed out");
        else this.end(peer.socket, PAIR_CLOSE.EXPIRED, "time ran out");
        continue;
      }
      next = Math.min(next ?? Infinity, peer.info.deadline, seen + IDLE_MS, this.passDue(peer.info, now));
    }
    return next;
  }
}
