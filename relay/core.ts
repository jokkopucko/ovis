/**
 * The Ovis relay's routing, shared by the Cloudflare Worker (worker.ts) and the Bun server
 * (bun.ts). A PC and a phone that cannot reach each other both dial out to the relay, which pairs
 * their sockets by the PC's `server_id` and passes frames between them unread: the frames are
 * end-to-end encrypted between the two (README.md). Nothing here parses, logs or keeps a frame
 * beyond the short wait for the PC's data socket, and nothing is stored.
 *
 * Three kinds of socket meet in one room per `server_id` (`GET /v1/ws?server_id=..&v=1`):
 * - control (`role=server`): one per PC. It hears `sync`, `connected` and `disconnected` (JSON
 *   text) about clients, and sends nothing but keepalive pings, pass renewals, and
 *   `{"type":"new_session","connection_id":".."}` once it identified a client as a device new to it.
 * - client (`role=client`): a phone or browser. The relay picks its `connection_id` and says so
 *   in its first frame, `{"type":"assigned","connection_id":"..."}`.
 * - data (`role=server&connection_id=..`): the PC's socket for one client, opened once the PC
 *   hears `connected` (or `sync`) for it. Frames then pass between client and data as they came.
 * - warm (`role=server&warm=<generation>`): a data socket the PC opened and proved before any
 *   client came, once `sync` said this relay takes one and named the control socket's generation
 *   (`"warm":"<32 hex>"`, new for every control socket). The next client to arrive while that
 *   control socket is connected takes it at once: it hears `{"type":"bound","connection_id":".."}`
 *   before any of the client's frames and is that client's data socket from then on, and the
 *   control socket hears no `connected` for that client. The PC then opens the next one. At most
 *   MAX_WARM wait per PC; one of another generation is refused, and one not bound closes with its
 *   control socket.
 *
 * A PC socket (control or data) offers the PC's public key, from which its `server_id` is derived,
 * and is no part of the room until it answers a challenge only the matching secret key can answer
 * (shared/relay-server-proof.ts): knowing a `server_id` is not enough to take a PC's place. A
 * client holds one of a server's MAX_CLIENTS slots only once the PC has answered it (its data
 * socket sent a frame); until then it is one of at most MAX_PENDING, closed HANDSHAKE_MS after the
 * PC could have answered.
 *
 * The room keeps no state that must outlive the process (or a Durable Object's eviction): who is
 * who lives with each socket (`RoomHost.info`), and a PC that reconnects gets the clients still
 * waiting in `sync`.
 *
 * Usage counters: a PC's control socket and each answered client count how long they stay
 * connected and how many bytes pass, and hand that to `RoomHost.usage` when the socket closes (and
 * every USAGE_REPORT_MS while it stays open). A report holds the server_id, which side, bytes each
 * way and the time; never a frame, an address or a connection_id.
 */

import { parsePairRequest, type PairSocketRequest } from "./pair-room.ts";
import { SERVER_KEY_INVALID, SERVER_KEY_MISMATCH, SERVER_PROOF_CLOSE, SERVER_PROOF_MS, SERVER_PROOF_REQUIRED, deriveServerId, proofKey, serverChallenge, verifyServerProof } from "../shared/relay-server-proof.ts";
import { RELAY_NEW_SESSIONS_CLOSE, RELAY_NEW_SESSIONS_REFUSED, RELAY_PASS_CLOSE, RELAY_PASS_EXPIRED, RELAY_PASS_HEADER, RELAY_PASS_INVALID, RELAY_PASS_REQUIRED, RELAY_PASS_SKEW_S } from "../shared/relay-pass.ts";
import { checkPass, passMayHold, passMode, passNotice, type PassPolicy, type PassResult, type PassState } from "./pass.ts";

/** the wire version this relay speaks, `v=` in the socket URL */
export const WIRE_VERSION = "1";
/** clients the PC has answered, one server_id may have at once */
export const MAX_CLIENTS = 8;
/** clients one server_id may have that the PC has not answered yet (waiting for their data socket, or for its first frame) */
export const MAX_PENDING = 4;
/**
 * PC sockets of one server_id that may wait to answer their challenge at once; past it the oldest
 * is closed. An answer takes the PC one round trip, so pushing its socket out takes this many
 * arrivals within that round trip.
 */
export const MAX_PROVING = 16;
/** proven warm sockets one server_id may keep waiting for a client; past it the oldest is closed */
export const MAX_WARM = 1;
/**
 * A warm socket silent this long (the PC pings it every 10 s) is not handed to a client: the PC may have
 * given it up while its close has not arrived, and the client would wait out its handshake deadline.
 */
export const WARM_QUIET_MS = 25_000;
/** the largest frame passed on, in bytes; Ovis frames stay under about 22 KiB */
export const MAX_MESSAGE_BYTES = 64 * 1024;
/** a client's frames held until its data socket attaches: at most this many... */
export const BUFFER_FRAMES = 200;
/** ...and at most this many bytes */
export const BUFFER_BYTES = 1024 * 1024;
/** a client the PC has not answered (its data socket sent nothing yet) is closed this long after the PC could have */
export const HANDSHAKE_MS = 15_000;
/**
 * a client waiting while no PC is connected is closed this long after it arrived or the PC left,
 * keepalives or not; the app itself gives up after 15 s (src/lib/relay/channel.ts PC_ANSWER_MS)
 */
export const OFFLINE_WAIT_MS = 30_000;
/** a socket that sends nothing (keepalive pings included) for this long is closed */
export const IDLE_MS = 120_000;
/**
 * The keepalive: a socket that sends exactly this text gets KEEPALIVE_PONG back and nothing is
 * passed on. On Cloudflare the runtime answers it without waking the Durable Object.
 */
export const KEEPALIVE_PING = '{"type":"ping"}';
export const KEEPALIVE_PONG = '{"type":"pong"}';
/** a socket open longer than this reports its usage so far, so a long connection shows up day by day */
export const USAGE_REPORT_MS = 5 * 60_000;
/** how stale a socket's saved last-seen time may get before it is written again (worker.ts saves it with the socket) */
const SEEN_WRITE_MS = 30_000;

/** WebSocket close codes the relay sends */
export const CLOSE = {
  /** the client went away (to its data socket), or the socket was idle */
  GOING_AWAY: 1001,
  /** a newer control socket replaced this one, a second data socket for one client, or an unknown wire version */
  POLICY: 1008,
  /** a frame over MAX_MESSAGE_BYTES */
  TOO_BIG: 1009,
  /** the PC's data socket went away (to its client), or the relay lost frames it held */
  RESTART: 1012,
  /** a limit: too many clients, too many waiting, too much held before the PC attached, no answer from the PC in time, or no PC connected in time */
  TRY_AGAIN: 1013,
  /** a PC socket without a valid answer to its challenge: no key, a key that is not this server_id's, a wrong or late answer */
  SERVER_PROOF: SERVER_PROOF_CLOSE,
  /** a PC socket without a relay pass that holds, while the relay asks for one (pass.ts) */
  RELAY_PASS: RELAY_PASS_CLOSE,
  /** a client the PC identified as a device new to it, while passes are enforced and the room's pass allows no new sessions (account limits); its other clients stay */
  NEW_SESSIONS: RELAY_NEW_SESSIONS_CLOSE,
} as const;

/** how long after its pass's expiry a room's PC sockets stay, for clocks that differ */
const PASS_SKEW_MS = RELAY_PASS_SKEW_S * 1000;
/** the largest renewal frame a control socket may send: `{"type":"relay_pass","pass":"..."}` */
const RENEWAL_BYTES = 1024;
/** the least time between two renewals one control socket may have checked (the PC renews every 12 hours) */
const RENEWAL_GAP_MS = 60_000;

export type Role = "control" | "data" | "client" | "warm";
export type Frame = string | ArrayBuffer | Uint8Array;

/** what a socket is, kept with the socket itself so it survives a Durable Object's eviction */
export interface SocketInfo {
  role: Role;
  connection_id: string | null;
  /** when it last sent something (written at most every SEEN_WRITE_MS) */
  seen: number;
  /** a client whose frames the relay holds (or held) for its data socket */
  buffered: boolean;
  /** a client the PC has answered (its data socket sent a frame): it holds one of MAX_CLIENTS */
  answered?: true;
  /** a client not answered yet: when it is closed unless the PC answers first (or, while no PC is connected, unless one connects) */
  deadline?: number;
  /** a client: when it arrived, so the oldest one not answered gives way to a newcomer */
  arrived?: number;
  /** a PC socket that has not answered its challenge yet: no part of the room until it does */
  proof?: { expected: string; expires: number };
  /** a PC socket still proving: its pass's expiry (ms) and key id, which authorize the room once the proof holds */
  pass_exp?: number;
  pass_kid?: string;
  /** a PC socket still proving: its pass allows no new client sessions, which it says for the room once the proof holds */
  pass_no_new?: true;
  /** a PC socket still proving: what the relay made of its pass, told to the PC in `sync` */
  pass_state?: PassState;
  /** a control socket's generation, new each time one is proven; a warm socket's, the one it was opened under */
  generation?: string;
  /** the room's server_id, kept with a socket whose usage is counted */
  server_id?: string;
  /** a proven control socket or a client: its usage not reported yet (a client's only once the PC answered it) */
  usage?: Usage;
  /**
   * the room closed it: a peer that vanished never answers that close, and the runtime keeps
   * listing the socket until it gives up, so an instance after an eviction must not end it again
   */
  ended?: true;
}

/** usage since `since` (ms): bytes from the device to the PC (`up`) and back (`down`) */
export interface Usage { since: number; up: number; down: number }

/** one socket's use of the relay since its last report: no frame content, address or connection_id */
export interface UsageReport {
  server_id: string;
  /** the PC's control socket, or a device's socket (which carries both directions of its pair) */
  side: "pc" | "device";
  up: number;
  down: number;
  /** milliseconds connected that this report covers */
  ms: number;
  /** whether the socket closed with this report (one finished session) */
  ended: boolean;
}

export interface SocketRequest {
  server_id: string;
  role: Role;
  connection_id: string | null;
  /** `v=` as given, checked once the socket is open so the client hears 1008, not an HTTP error */
  version: string | null;
  /** a PC socket's `proof=` and `public_key=` as given, checked once the socket is open (4401) */
  proof?: string | null;
  public_key?: string | null;
  /** a warm socket's control generation, as given */
  generation?: string;
  /** a PC socket's pass, checked by `admit` when the relay has a pass policy that is not off */
  pass?: PassResult;
}

/** Cloudflare's Rate Limiting binding, or anything with its shape */
export interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
export interface Limiters {
  /** keyed by the connecting address */
  perAddress: RateLimiter;
  /** asked with one key for all addresses, only once an address's own limit (or a PC's) lets it through */
  global: RateLimiter;
  /**
   * keyed by server_id: a budget of its own for a PC socket whose relay pass holds, once its address's is spent,
   * so PCs behind one address (an office's NAT) are not held to its budget. Asked only while passes are on.
   */
  perPc?: RateLimiter;
  /** keyed by the address: how many passes it may have checked once its own budget is spent, which bounds what a flood of passes costs */
  passChecks?: RateLimiter;
}

const HEX32 = /^[0-9a-f]{32}$/;

/** The socket a `/v1/ws` URL asks for, or why it is refused (HTTP 400). */
export function parseSocketRequest(url: URL): SocketRequest | { error: string } {
  const params = url.searchParams;
  const serverId = params.get("server_id") ?? "";
  if (!HEX32.test(serverId)) return { error: "server_id must be 32 lowercase hex digits" };
  const role = params.get("role");
  const connectionId = params.get("connection_id");
  const version = params.get("v");
  if (role === "client") {
    if (connectionId !== null) return { error: "the relay assigns a client's connection_id" };
    return { server_id: serverId, role: "client", connection_id: null, version };
  }
  if (role !== "server") return { error: "role must be server or client" };
  const proof = { proof: params.get("proof"), public_key: params.get("public_key") };
  const generation = params.get("warm");
  if (generation !== null) {
    if (!HEX32.test(generation) || connectionId !== null) return { error: "warm must be 32 lowercase hex digits, without a connection_id" };
    return { server_id: serverId, role: "warm", connection_id: null, version, ...proof, generation };
  }
  if (connectionId === null) return { server_id: serverId, role: "control", connection_id: null, version, ...proof };
  if (!HEX32.test(connectionId)) return { error: "connection_id must be 32 lowercase hex digits" };
  return { server_id: serverId, role: "data", connection_id: connectionId, version, ...proof };
}

const text = (status: number, body: string, headers?: Record<string, string>) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });

/**
 * The HTTP side of both adapters: `/health`, and the checks a socket request passes before it is
 * upgraded. Returns the response to send, or the socket to open. `address` keys the per-address
 * limiter only; it is never kept.
 */
export async function admit(request: Request, address: string, limiters?: Limiters, policy?: PassPolicy): Promise<Response | SocketRequest | PairSocketRequest> {
  const url = new URL(request.url);
  if (url.pathname === "/health") return request.method === "GET" || request.method === "HEAD" ? text(200, "ok") : text(405, "", { allow: "GET" });
  if (url.pathname !== "/v1/ws" && url.pathname !== "/v1/pair") return text(404, "not found");
  if (request.method !== "GET") return text(405, "", { allow: "GET" });
  // the rendezvous for pairing with a typed code (pair-room.ts), under the same limits
  const socket = url.pathname === "/v1/pair" ? parsePairRequest(url) : parseSocketRequest(url);
  if ("error" in socket) return text(400, socket.error);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "expected a WebSocket upgrade", { upgrade: "websocket" });
  // a PC socket's server_id: only those get the rescue below; a pairing host still counts against its address
  const pcServerId = "kind" in socket || socket.role === "client" ? undefined : socket.server_id;
  const header = request.headers.get(RELAY_PASS_HEADER);
  const tooMany = () => text(429, "too many connections", { "retry-after": "60" });
  let pass: PassResult | undefined;
  if (limiters) {
    if ((await limiters.perAddress.limit({ key: address })).success) {
      if (!(await limiters.global.limit({ key: "all" })).success) return tooMany();
    } else {
      // past its address's budget (others behind the same NAT, say), a PC whose relay pass holds gets in on a budget of its own
      const { perPc, passChecks } = limiters;
      if (!policy || policy.mode === "off" || pcServerId === undefined || !perPc || !passChecks || !passMayHold(policy, header, pcServerId, Date.now())) return tooMany();
      // each signature checked here takes one of the address's checks and one of the backstop's places: forged passes cost little
      if (!(await passChecks.limit({ key: address })).success || !(await limiters.global.limit({ key: "all" })).success) return tooMany();
      pass = await checkPass(policy, header, pcServerId, Date.now());
      if (pass.state !== "ok" || !(await perPc.limit({ key: pcServerId })).success) return tooMany();
    }
  }
  // otherwise checked after the limits, so a flood of requests costs no signature checks; a pairing host's pass, for the key it offers
  const serverId = "kind" in socket ? socket.key?.server_id : pcServerId;
  if (!policy || policy.mode === "off" || serverId === undefined) return socket;
  return { ...socket, pass: pass ?? await checkPass(policy, header, serverId, Date.now()) };
}

/** Why a PC socket or a pairing host must close at once for its pass (`enforce` and no pass that holds), or null. */
export function passRefusal(socket: Pick<SocketRequest, "role" | "pass"> | PairSocketRequest, policy: PassPolicy | undefined, now: number): string | null {
  if (!policy || socket.role === "client" || socket.role === "guest" || passMode(policy, now) !== "enforce") return null;
  return socket.pass?.state === "ok" ? null : socket.pass?.reason ?? RELAY_PASS_REQUIRED;
}

/** A room's relay pass authorization: the latest expiry any of its proven PC sockets' passes gave, that pass's key id, and whether it allows no new client sessions. */
export interface RoomAuthorization { readonly until: number; readonly kid: string; readonly noNew?: true }
export interface RoomPass {
  readonly policy: PassPolicy;
  /** the authorization, or null when no pass authorized this room */
  until(): RoomAuthorization | null;
  /** keeps it; the host saves it where it outlives an eviction */
  setUntil(value: RoomAuthorization): void;
}

/** what a room needs from the platform's sockets */
export interface RoomHost<S extends object> {
  /** every socket of this room still open (or closing) */
  sockets(): Iterable<S>;
  info(socket: S): SocketInfo | null;
  setInfo(socket: S, info: SocketInfo): void;
  send(socket: S, frame: Frame): void;
  close(socket: S, code: number, reason: string): void;
  /** when the platform last answered this socket's keepalive by itself, if it does */
  keepaliveAt?(socket: S): number | null;
  /** takes a usage report; a host without it counts nothing anywhere */
  usage?(report: UsageReport): void;
  /** `sweep` is due by `at` (a deadline was set); a host that sweeps on a timer may ignore it */
  wake?(at: number): void;
  now(): number;
  /** the relay pass policy and this room's authorization; without it every PC is let in, as before */
  pass?: RoomPass;
}

interface Held { frames: Frame[]; bytes: number }

const randomHex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** UTF-8 length of a text frame, without encoding it */
function utf8Length(value: string): number {
  let length = 0;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x80) length += 1;
    else if (code < 0x800) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) { length += 4; i++; }
    else length += 3;
  }
  return length;
}

const byteLength = (frame: Frame) => typeof frame === "string" ? utf8Length(frame) : frame.byteLength;
/** a frame the platform may reuse once the handler returns, copied to be held */
const own = (frame: Frame): Frame => typeof frame === "string" ? frame : frame instanceof Uint8Array ? frame.slice() : frame.slice(0);

/** One server_id's sockets: pairs them, passes frames, enforces the limits. */
export class Room<S extends object> {
  /** frames of clients whose data socket has not attached yet, by connection_id */
  private readonly held = new Map<string, Held>();
  /** sockets the room has finished with (closed by either side) */
  private readonly ended = new WeakSet<S>();
  /** when each socket last sent something, exact (SocketInfo.seen lags by up to SEEN_WRITE_MS) */
  private readonly lastSeen = new WeakMap<S, number>();
  /** clients this instance closed because the frames held for them were lost (a Durable Object evicted mid-wait) */
  heldFramesLost = 0;

  constructor(private readonly host: RoomHost<S>) {}

  /** the room's sockets; PC sockets still proving their key only with `proving` */
  private peers(proving = false): { socket: S; info: SocketInfo }[] {
    const out: { socket: S; info: SocketInfo }[] = [];
    for (const socket of this.host.sockets()) {
      if (this.ended.has(socket)) continue;
      const info = this.host.info(socket);
      if (info && !info.ended && (proving || !info.proof)) out.push({ socket, info });
    }
    return out;
  }

  private setDeadline(socket: S, info: SocketInfo, at: number): void {
    this.host.setInfo(socket, { ...info, deadline: at });
    this.host.wake?.(at);
  }

  /** the frames held for a client were lost with an evicted instance: the pair cannot start where the client thinks it did */
  private lostHeld(client: S): void {
    this.heldFramesLost++;
    this.end(client, CLOSE.RESTART, "relay restarted");
  }

  private find(role: Role, connectionId: string): { socket: S; info: SocketInfo } | undefined {
    return this.peers().find((peer) => peer.info.role === role && peer.info.connection_id === connectionId);
  }

  private tellControls(message: object): void {
    const body = JSON.stringify(message);
    for (const peer of this.peers()) if (peer.info.role === "control") this.host.send(peer.socket, body);
  }

  /** hands `usage` to the host when the socket ended or it is due; returns what is left to report */
  private report(info: SocketInfo, usage: Usage, now: number, ended: boolean): Usage {
    if (!ended && now - usage.since < USAGE_REPORT_MS) return usage;
    // a client the PC never answered is no session: what it sent is dropped with it
    if (info.role === "client" && !info.answered) return usage;
    if (info.server_id !== undefined) this.host.usage?.({ server_id: info.server_id, side: info.role === "control" ? "pc" : "device", up: usage.up, down: usage.down, ms: Math.max(0, now - usage.since), ended });
    return { since: now, up: 0, down: 0 };
  }

  /** counts a frame passed on for a client, reporting when due */
  private count(socket: S, direction: "up" | "down", size: number, now: number): void {
    const info = this.host.info(socket);
    if (!info?.usage) return;
    const usage = { ...info.usage, [direction]: info.usage[direction] + size };
    this.host.setInfo(socket, { ...info, usage: this.report(info, usage, now, false) });
  }

  /** Closes a socket and ends it in the room, its partner with it. Safe to call more than once. */
  end(socket: S, code: number, reason: string): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    // an instance before an eviction ended it already
    if (info?.ended) { this.ended.add(socket); return; }
    // marked before the close, while the socket can still keep it
    if (info) this.host.setInfo(socket, { ...info, ended: true });
    this.host.close(socket, code, reason);
    this.finish(socket, info);
  }

  /** A socket was upgraded: place it, or close it when the room refuses it. */
  open(socket: S, request: Pick<SocketRequest, "server_id" | "role" | "connection_id" | "version" | "proof" | "public_key" | "generation" | "pass">): void {
    if (request.version !== WIRE_VERSION) return this.end(socket, CLOSE.POLICY, "unsupported wire version");
    // the room wakes when enforcement begins, so sockets let in during grace do not outlive it
    const policy = this.host.pass?.policy;
    if (policy?.mode === "grace" && policy.enforceAt !== null && this.host.now() < policy.enforceAt) this.host.wake?.(policy.enforceAt);
    if (request.role === "client") return this.openClient(socket, request.server_id);
    const refused = passRefusal(request, this.host.pass?.policy, this.host.now());
    if (refused !== null) return this.end(socket, CLOSE.RELAY_PASS, refused);
    // a PC socket: nothing of the room until it proves it holds the key this server_id derives from
    if (request.proof !== "1") return this.end(socket, CLOSE.SERVER_PROOF, SERVER_PROOF_REQUIRED);
    const key = proofKey(request.public_key);
    if (!key || deriveServerId(key) !== request.server_id) return this.end(socket, CLOSE.SERVER_PROOF, SERVER_KEY_MISMATCH);
    const proving = this.peers(true).filter((peer) => peer.info.proof).sort((a, b) => a.info.proof!.expires - b.info.proof!.expires);
    // the oldest challenge gives way, so silent sockets cannot keep the PC itself from proving
    for (const peer of proving.slice(0, Math.max(0, proving.length - MAX_PROVING + 1))) this.end(peer.socket, CLOSE.TRY_AGAIN, "too many server proofs pending");
    let challenge: ReturnType<typeof serverChallenge>;
    // a warm socket's proof covers its generation, carried where a data socket's covers its connection_id
    try { challenge = serverChallenge(key, { server_id: request.server_id, role: request.role, connection_id: request.role === "warm" ? request.generation ?? null : request.connection_id }); }
    catch { return this.end(socket, CLOSE.SERVER_PROOF, SERVER_KEY_INVALID); } // a low-order X25519 point
    const now = this.host.now();
    const expires = now + SERVER_PROOF_MS;
    this.host.setInfo(socket, { role: request.role, connection_id: request.connection_id, seen: now, buffered: false, proof: { expected: challenge.expected, expires }, server_id: request.server_id,
      ...(request.role === "warm" ? { generation: request.generation } : {}),
      ...(request.pass ? { pass_state: request.pass.state, ...(request.pass.exp !== undefined && request.pass.kid !== undefined ? { pass_exp: request.pass.exp, pass_kid: request.pass.kid, ...(request.pass.noNew ? { pass_no_new: true as const } : {}) } : {}) } : {}) });
    this.lastSeen.set(socket, now);
    this.host.send(socket, challenge.frame);
    this.host.wake?.(expires);
  }

  private openClient(socket: S, serverId: string): void {
    const now = this.host.now();
    const peers = this.peers();
    const clients = peers.filter((peer) => peer.info.role === "client");
    const answered = clients.filter((peer) => peer.info.answered).length;
    if (answered >= MAX_CLIENTS) return this.end(socket, CLOSE.TRY_AGAIN, "too many clients for this server");
    // the oldest client not answered gives way: holding the waiting places then takes MAX_PENDING
    // arrivals within one real phone's handshake, not one arrival per HANDSHAKE_MS
    const waiting = clients.filter((peer) => !peer.info.answered).sort((a, b) => (a.info.arrived ?? a.info.seen) - (b.info.arrived ?? b.info.seen));
    for (const peer of waiting.slice(0, Math.max(0, waiting.length - MAX_PENDING + 1))) this.end(peer.socket, CLOSE.TRY_AGAIN, "too many clients waiting for this server");
    const connectionId = randomHex();
    const info: SocketInfo = { role: "client", connection_id: connectionId, seen: now, buffered: false, arrived: now, server_id: serverId, usage: { since: now, up: 0, down: 0 } };
    this.host.setInfo(socket, info);
    this.lastSeen.set(socket, now);
    // with a PC connected, the client must be answered in time; without one it waits a while for the PC
    const controlled = peers.some((peer) => peer.info.role === "control");
    this.setDeadline(socket, info, now + (controlled ? HANDSHAKE_MS : OFFLINE_WAIT_MS));
    // outside `off`, a client of a PC without a pass that holds hears so: the app can warn about a PC too old to warn itself
    const pass = this.host.pass;
    const notice = pass && pass.policy.mode !== "off" && !this.authorized(now) ? { relay_pass: passNotice(pass.policy, "missing") } : {};
    this.host.send(socket, JSON.stringify({ type: "assigned", connection_id: connectionId, ...notice }));
    const generation = peers.find((peer) => peer.info.role === "control")?.info.generation;
    let warm = generation ? peers.find((peer) => peer.info.role === "warm" && peer.info.generation === generation) : undefined;
    // one the PC stopped keeping alive may be gone on its side (half-open): the client is announced instead
    if (warm && now - Math.max(this.lastSeen.get(warm.socket) ?? warm.info.seen, this.host.keepaliveAt?.(warm.socket) ?? 0) >= WARM_QUIET_MS) {
      this.end(warm.socket, CLOSE.GOING_AWAY, "warm socket went quiet");
      warm = undefined;
    }
    if (!warm) return this.tellControls({ type: "connected", connection_id: connectionId });
    // the PC's warm socket becomes this client's data socket, saved as such before any frame passes
    this.host.setInfo(warm.socket, { role: "data", connection_id: connectionId, seen: now, buffered: false });
    this.lastSeen.set(warm.socket, now);
    this.host.send(warm.socket, JSON.stringify({ type: "bound", connection_id: connectionId }));
  }

  /** Closes the warm sockets no client has taken, those still proving included. */
  private endWarm(reason: string): void {
    for (const peer of this.peers(true)) if (peer.info.role === "warm") this.end(peer.socket, CLOSE.GOING_AWAY, reason);
  }

  /** this room's server_id, from any of its sockets (a room is one server_id's, so it is kept once found) */
  private roomServerId: string | undefined;
  private serverId(): string | undefined {
    if (this.roomServerId === undefined) for (const peer of this.peers(true)) if (peer.info.server_id !== undefined) { this.roomServerId = peer.info.server_id; break; }
    return this.roomServerId;
  }

  /** whether passes are enforced now and none authorizes the room: then nothing more passes until the sweep closed its PC sockets */
  private lapsed(now: number): boolean {
    const pass = this.host.pass;
    return pass !== undefined && pass.policy.mode !== "off" && passMode(pass.policy, now) === "enforce" && !this.authorized(now);
  }

  /**
   * Whether a pass that holds authorized this room at `now` (skew allowed): under a key the relay
   * still trusts, for a server_id it has not revoked, so a saved authorization never outlives a
   * change to either.
   */
  private authorized(now: number): boolean {
    const pass = this.host.pass;
    const auth = pass?.until() ?? null;
    if (!pass || !auth || !pass.policy.keys.has(auth.kid)) return false;
    const serverId = this.serverId();
    return (serverId === undefined || !pass.policy.revoked.has(serverId)) && now < auth.until + PASS_SKEW_MS;
  }

  /** Whether passes are enforced now and the pass that authorizes the room allows no new client sessions. */
  private refusesNewSessions(now: number): boolean {
    const pass = this.host.pass;
    return pass !== undefined && passMode(pass.policy, now) === "enforce" && this.authorized(now) && pass.until()?.noNew === true;
  }

  /**
   * A proven PC socket's pass authorizes the room until its expiry, and says whether new client
   * sessions are allowed; an earlier expiry changes nothing while the saved one holds, so the pass
   * issued last (which runs out last) decides, and of two issued the same second the stricter.
   */
  private authorize(until: number, kid: string, noNew: boolean): void {
    const pass = this.host.pass;
    if (!pass) return;
    const current = pass.until();
    // one with the same expiry was issued the same second: the stricter of the two holds, whichever is proven last
    if (current && this.authorized(this.host.now()) && (until < current.until || (until === current.until && (!noNew || current.noNew === true)))) return;
    pass.setUntil({ until, kid, ...(noNew ? { noNew: true as const } : {}) });
    this.host.wake?.(until + PASS_SKEW_MS);
  }

  /** when each control socket last had a renewal checked, and those being checked now */
  private readonly renewedAt = new WeakMap<S, number>();
  private readonly renewing = new WeakSet<S>();

  /** A renewal on a proven control socket: `{"type":"relay_pass","pass":"..."}`, checked as at admission. */
  private async renew(socket: S, info: SocketInfo, text: string): Promise<void> {
    const pass = this.host.pass;
    if (!pass || pass.policy.mode === "off" || info.server_id === undefined) return;
    // one check at a time and one a minute per socket: a forged renewal costs the relay one signature check a minute
    const now = this.host.now();
    if (this.renewing.has(socket) || now - (this.renewedAt.get(socket) ?? -Infinity) < RENEWAL_GAP_MS) return;
    this.renewing.add(socket);
    this.renewedAt.set(socket, now);
    try {
      const result = await checkPass(pass.policy, text, info.server_id, now);
      // the socket may have closed (its pass ran out, say) while the signature was checked
      if (this.ended.has(socket) || this.host.info(socket)?.role !== "control") return;
      if (result.state === "ok" && result.exp !== undefined && result.kid !== undefined) this.authorize(result.exp, result.kid, result.noNew === true);
    } finally { this.renewing.delete(socket); }
  }

  /** A PC socket answered its challenge: it takes its place in the room. */
  private attach(socket: S, info: SocketInfo): void {
    const now = this.host.now();
    const peers = this.peers();
    if (info.pass_exp !== undefined && info.pass_kid !== undefined) this.authorize(info.pass_exp, info.pass_kid, info.pass_no_new === true);
    if (info.role === "control") {
      // the newest proven control socket wins: an older one may be half-open after the PC's network moved
      for (const peer of peers) if (peer.info.role === "control") this.end(peer.socket, CLOSE.POLICY, "replaced by a newer control socket");
      // a warm socket belongs to the control socket it was opened under: the PC opens another for this one
      this.endWarm("replaced by a newer control socket");
      const generation = randomHex();
      this.host.setInfo(socket, { role: "control", connection_id: null, seen: now, buffered: false, server_id: info.server_id, usage: { since: now, up: 0, down: 0 }, generation });
      this.lastSeen.set(socket, now);
      const waiting = peers.filter((peer) => peer.info.role === "client" && !peers.some((other) => other.info.role === "data" && other.info.connection_id === peer.info.connection_id));
      // the PC (back) gets the full HANDSHAKE_MS to answer every client still waiting
      for (const peer of waiting) this.setDeadline(peer.socket, peer.info, now + HANDSHAKE_MS);
      const pass = this.host.pass;
      // outside `off` the PC hears whether its pass holds; an older PC reads only connection_ids and warm
      const notice = pass && pass.policy.mode !== "off" ? { relay_pass: passNotice(pass.policy, this.authorized(now) ? "ok" : info.pass_state ?? "missing") } : {};
      this.host.send(socket, JSON.stringify({ type: "sync", connection_ids: waiting.map((peer) => peer.info.connection_id), warm: generation, ...notice }));
      return;
    }
    if (info.role === "warm") {
      // opened under a control socket that is gone or replaced: no client may land on it
      if (!peers.some((peer) => peer.info.role === "control" && peer.info.generation === info.generation)) return this.end(socket, CLOSE.GOING_AWAY, "no control socket of its generation");
      const warm = peers.filter((peer) => peer.info.role === "warm").sort((a, b) => a.info.seen - b.info.seen);
      for (const peer of warm.slice(0, Math.max(0, warm.length - MAX_WARM + 1))) this.end(peer.socket, CLOSE.POLICY, "replaced by a newer warm socket");
      this.host.setInfo(socket, { role: "warm", connection_id: null, seen: now, buffered: false, generation: info.generation! });
      this.lastSeen.set(socket, now);
      return;
    }
    const connectionId = info.connection_id!;
    const client = peers.find((peer) => peer.info.role === "client" && peer.info.connection_id === connectionId);
    if (!client) return this.end(socket, CLOSE.GOING_AWAY, "client gone");
    if (peers.some((peer) => peer.info.role === "data" && peer.info.connection_id === connectionId)) return this.end(socket, CLOSE.POLICY, "this client already has a data socket");
    this.host.setInfo(socket, { role: "data", connection_id: connectionId, seen: now, buffered: false });
    this.lastSeen.set(socket, now);
    const held = this.held.get(connectionId);
    this.held.delete(connectionId);
    // the client's first frames were held by an instance that is gone (an evicted Durable Object)
    if (client.info.buffered && !held) return this.lostHeld(client.socket);
    for (const frame of held?.frames ?? []) this.host.send(socket, frame);
    // the PC has HANDSHAKE_MS from now to answer the client
    this.setDeadline(client.socket, { ...client.info, buffered: false }, now + HANDSHAKE_MS);
  }

  /** A frame arrived on a socket: pass it on unread. A pass renewal settles when its check is done. */
  message(socket: S, frame: Frame): void | Promise<void> {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    // a frame the peer sent before an earlier instance closed it
    if (!info || info.ended) return;
    if (info.proof) {
      // the first frame of a PC socket is its answer, compared in constant time; anything else, or late, is refused
      if (this.host.now() >= info.proof.expires || !verifyServerProof(frame, info.proof.expected)) return this.end(socket, CLOSE.SERVER_PROOF, "invalid or expired server proof");
      // a pass that ran out while its socket proved lets it in only where another pass still holds
      const pass = this.host.pass;
      const now = this.host.now();
      if (pass && passMode(pass.policy, now) === "enforce" && !(info.pass_exp !== undefined && now < info.pass_exp + PASS_SKEW_MS) && !this.authorized(now)) {
        return this.end(socket, CLOSE.RELAY_PASS, info.pass_exp === undefined ? RELAY_PASS_REQUIRED : RELAY_PASS_EXPIRED);
      }
      return this.attach(socket, info);
    }
    const size = byteLength(frame);
    if (size > MAX_MESSAGE_BYTES) return this.end(socket, CLOSE.TOO_BIG, "message too big");
    const now = this.host.now();
    // the pass ran out (or enforcement began) since the last sweep: the room's PC sockets close before this frame goes anywhere
    if (this.lapsed(now)) {
      this.sweepPass(now);
      if (this.ended.has(socket)) return;
    }
    this.lastSeen.set(socket, now);
    if (now - info.seen >= SEEN_WRITE_MS) this.host.setInfo(socket, { ...info, seen: now });
    if (frame === KEEPALIVE_PING) return this.host.send(socket, KEEPALIVE_PONG);
    if (info.role === "control" && typeof frame === "string" && size <= RENEWAL_BYTES) {
      let value: unknown;
      try { value = JSON.parse(frame); } catch { return; }
      const { type, pass, connection_id } = typeof value === "object" && value !== null ? value as { type?: unknown; pass?: unknown; connection_id?: unknown } : {};
      if (type === "relay_pass" && typeof pass === "string") return this.renew(socket, info, pass);
      // the PC identified this client as a device new to it (the relay cannot: its frames are end-to-end encrypted)
      if (type === "new_session" && typeof connection_id === "string" && this.refusesNewSessions(now)) {
        const client = this.find("client", connection_id);
        if (client) this.end(client.socket, CLOSE.NEW_SESSIONS, RELAY_NEW_SESSIONS_REFUSED);
      }
      return;
    }
    if (info.role === "control" || info.role === "warm") return;
    const connectionId = info.connection_id!;
    if (info.role === "data") {
      const client = this.find("client", connectionId);
      if (!client) return;
      if (!client.info.answered) {
        // the PC answered the client: it now holds one of the server's slots, and its session starts
        if (this.peers().filter((peer) => peer.info.role === "client" && peer.info.answered).length >= MAX_CLIENTS) return this.end(client.socket, CLOSE.TRY_AGAIN, "too many clients for this server");
        const { deadline: _deadline, ...rest } = client.info;
        // its time counts from here; what it sent while waiting (its first handshake frames) stays counted
        this.host.setInfo(client.socket, { ...rest, answered: true, usage: { since: now, up: rest.usage?.up ?? 0, down: 0 } });
      }
      this.count(client.socket, "down", size, now);
      this.host.send(client.socket, frame);
      return;
    }
    this.count(socket, "up", size, now);
    const data = this.find("data", connectionId);
    if (data) return this.host.send(data.socket, frame);
    // frames were held for this client by an instance that is gone: holding more would hand the PC a stream with a hole
    if (info.buffered && !this.held.has(connectionId)) return this.lostHeld(socket);
    const held = this.held.get(connectionId) ?? { frames: [], bytes: 0 };
    if (held.frames.length >= BUFFER_FRAMES || held.bytes + size > BUFFER_BYTES) return this.end(socket, CLOSE.TRY_AGAIN, "too much sent before the server attached");
    held.frames.push(own(frame));
    held.bytes += size;
    this.held.set(connectionId, held);
    if (!info.buffered) this.host.setInfo(socket, { ...(this.host.info(socket) ?? info), buffered: true });
  }

  /** A socket closed (or failed): close its partner. Safe to call more than once. */
  closed(socket: S): void {
    if (this.ended.has(socket)) return;
    const info = this.host.info(socket);
    // an instance before an eviction ended it already; this is the runtime giving up on its close
    if (info?.ended) { this.ended.add(socket); return; }
    this.finish(socket, info);
  }

  private finish(socket: S, info: SocketInfo | null): void {
    this.ended.add(socket);
    if (!info || info.proof) return;
    if (info.usage) this.report(info, info.usage, this.host.now(), true);
    if (info.role === "warm") return;
    if (info.role === "control") {
      if (!this.peers().some((peer) => peer.info.role === "control")) this.endWarm("control socket gone");
      return this.pauseWaiting();
    }
    const connectionId = info.connection_id!;
    if (info.role === "client") {
      this.held.delete(connectionId);
      const data = this.find("data", connectionId);
      if (data) this.end(data.socket, CLOSE.GOING_AWAY, "client gone");
      this.tellControls({ type: "disconnected", connection_id: connectionId });
      return;
    }
    const client = this.find("client", connectionId);
    if (client) this.end(client.socket, CLOSE.RESTART, "server gone");
  }

  /** No PC is connected any more: clients waiting for a data socket wait OFFLINE_WAIT_MS for the PC to come back. */
  private pauseWaiting(): void {
    const peers = this.peers();
    if (peers.some((peer) => peer.info.role === "control")) return;
    const at = this.host.now() + OFFLINE_WAIT_MS;
    for (const peer of peers) {
      if (peer.info.role !== "client" || peer.info.answered) continue;
      if (peers.some((other) => other.info.role === "data" && other.info.connection_id === peer.info.connection_id)) continue;
      this.setDeadline(peer.socket, peer.info, at);
    }
  }

  /** Closes sockets idle for IDLE_MS; returns when the next one would be due, or null when none is left. */
  sweep(): number | null {
    const now = this.host.now();
    let next: number | null = this.sweepPass(now);
    for (const peer of this.peers(true)) {
      if (this.ended.has(peer.socket)) continue;
      // a PC socket that has not answered its challenge, and a client the PC has not answered, close at their deadline whatever keepalives they send
      const due = peer.info.proof?.expires ?? peer.info.deadline;
      if (due !== undefined && now >= due) {
        if (peer.info.proof) this.end(peer.socket, CLOSE.SERVER_PROOF, "server proof timed out");
        else this.end(peer.socket, CLOSE.TRY_AGAIN, this.peers().some((other) => other.info.role === "control") ? "the server did not answer in time" : "the server is not connected");
        continue;
      }
      // without this instance's exact time (a Durable Object evicted since), the saved one may lag
      // the last frame by up to SEEN_WRITE_MS: count from its latest possible time, so a socket is
      // never closed sooner than IDLE_MS after its last frame (and at most SEEN_WRITE_MS later)
      const sent = this.lastSeen.get(peer.socket) ?? peer.info.seen + SEEN_WRITE_MS;
      const last = Math.max(sent, this.host.keepaliveAt?.(peer.socket) ?? 0);
      if (now - last >= IDLE_MS) {
        this.end(peer.socket, CLOSE.GOING_AWAY, "idle");
        continue;
      }
      next = Math.min(next ?? Infinity, last + IDLE_MS, due ?? Infinity);
      // a PC's control socket wakes the room only here (its keepalive is answered without it)
      const info = this.host.info(peer.socket);
      const usage = info?.usage && this.report(info, info.usage, now, false);
      if (info && usage && usage !== info.usage) this.host.setInfo(peer.socket, { ...info, usage });
    }
    return next;
  }

  /**
   * While passes are enforced, a room without a pass that holds keeps no PC socket: sockets let in
   * before enforcement began, or whose pass ran out without a renewal, close 4402 (their clients
   * with them). A socket still proving with a pass that holds may stay: its proof authorizes the room.
   * Returns when the room's authorization (or the start of enforcement) is next due.
   */
  private sweepPass(now: number): number | null {
    const pass = this.host.pass;
    if (!pass || pass.policy.mode === "off" || this.empty) return null;
    if (passMode(pass.policy, now) !== "enforce") return pass.policy.enforceAt;
    if (this.authorized(now)) return pass.until()!.until + PASS_SKEW_MS;
    const auth = pass.until();
    const serverId = this.serverId();
    const reason = auth === null ? RELAY_PASS_REQUIRED : now < auth.until + PASS_SKEW_MS || (serverId !== undefined && pass.policy.revoked.has(serverId)) ? RELAY_PASS_INVALID : RELAY_PASS_EXPIRED;
    // warm sockets first: closing the control socket first would end them 1001 instead of saying why
    const peers = this.peers(true).sort((a, b) => Number(b.info.role === "warm") - Number(a.info.role === "warm"));
    for (const peer of peers) {
      if (peer.info.role === "client" || (peer.info.proof && peer.info.pass_exp !== undefined && now < peer.info.pass_exp + PASS_SKEW_MS)) continue;
      this.end(peer.socket, CLOSE.RELAY_PASS, reason);
    }
    return null;
  }

  /** whether any socket of this room is still in use */
  get empty(): boolean {
    return this.peers(true).length === 0;
  }
}
