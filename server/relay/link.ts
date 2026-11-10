import { importPublicKey, importSecretKey, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import type { RequestServices } from "../dispatch.ts";
import type { RelayIdentity } from "./identity.ts";
import { PAIR_APPROVAL_MS } from "../../shared/relay-pair-sas.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySocketHandlers } from "./virtual-socket.ts";
import { version } from "../../package.json";
import { bytesToHex } from "@noble/hashes/utils.js";
import { answerServerChallenge, PERMANENT_SERVER_PROOF_REFUSALS, SERVER_PROOF_CLOSE } from "../../shared/relay-server-proof.ts";
import { RELAY_PASS_CLOSE, RELAY_PASS_HEADER, parseRelayPass, relayPassAdmitsNewSessions } from "../../shared/relay-pass.ts";
import { SignedInSessions } from "./admissions.ts";
import type { RelayErrorCode } from "../../shared/protocol.ts";

/** The fixed codes a link's own errors carry. */
export type LinkErrorCode = Extract<RelayErrorCode, "relay_unreachable" | "server_key_refused" | "pass_required">;

/** Signed-in sessions this PC serves at once, as many as the relay lets in (relay/core.ts MAX_CLIENTS). */
const MAX_SESSIONS = 8;
/** Clients still signing in beyond those, as many as the relay holds waiting (relay/core.ts MAX_PENDING). */
const MAX_PENDING = 4;
/** A relay control message is a short JSON object (a sync names at most 8 ids). */
const CONTROL_MESSAGE_BYTES = 4096;
/** A client whose sign-in or pairing is being verified at its deadline gets this long to finish. */
const SIGN_IN_GRACE_MS = 5_000;
/** How long a PC the relay refused for its pass waits before trying again with no new pass. */
const PASS_REFUSED_RETRY_MS = 30 * 60_000;
/** How long the relay gets to close a client this PC named as a new device before the PC closes its data socket itself. */
const NEW_SESSION_CLOSE_MS = 2_000;
/**
 * The least time between two pass renewals on one control socket. The relay checks one a minute per socket and drops
 * any sooner without a word (relay/core.ts RENEWAL_GAP_MS), counted from when each reached it: 5 s more covers a first
 * one that travelled longer than the second.
 */
const RENEWAL_GAP_MS = 65_000;

export interface RelayLinkOptions {
  readonly relay: string;
  readonly identity: RelayIdentity;
  readonly services: RequestServices;
  /** The server's listening port, resolved after binding (including port: 0). */
  readonly port: number;
  /** Opens a socket; `headers` carries the relay pass on Ovis's relays. */
  readonly connect?: (url: string, headers?: Record<string, string>) => WebSocket;
  /** This PC's relay pass for this relay, or null: sent with every PC socket (shared/relay-pass.ts). */
  readonly pass?: () => string | null;
  /**
   * The pass this relay may still hold the PC to, read only for what it says of new client sessions: `pass`, and once
   * the PC stopped sending that (shortly before it runs out) the same one until the relay stops honoring it
   * (server/relay/pass.ts honored). Whoever gives it times it; `pass` when not given.
   */
  readonly honoredPass?: () => string | null;
  /** What the relay said of the pass in `sync` (relay/README.md, "Relay pass"). */
  /** Every `sync`: what the relay said of the pass, or null when it said nothing (it asks for none). */
  readonly onPassNotice?: (notice: RelayPassNotice | null) => void;
  /** The relay refused this PC's pass (4402): a new one is asked for. */
  readonly onPassRefused?: () => void;
  readonly clock?: MuxClock;
  /** The wall clock (ms) the relay's `enforce_at` is read against; Date.now by default. */
  readonly now?: () => number;
  readonly random?: () => number;
  /** The version WELCOME tells the shell (src/lib/relay/skew.ts); package.json's by default. */
  readonly serverVersion?: string;
  /** `code` is the error as a fixed code (shared/protocol.ts RelayErrorCode); a pass refusal is `pass_required`, which the service makes more exact */
  readonly onState: (phase: "connecting" | "online" | "error", error: string | null, code?: LinkErrorCode) => void;
  /** The relays a phone is told to reach this PC through (RelaySession relayHints). */
  readonly relayHints?: () => readonly string[];
  /** This PC's direct carriers (RelaySession directCarriers). */
  readonly directCarriers?: (tailnet: boolean) => readonly string[];
  /** The PC's signed-in sessions over every way in (admissions.ts); this link's own when not given. */
  readonly sessions?: SignedInSessions;
}

/** `mode` is the relay's configured pass mode; a relay from before it said so names none. */
export interface RelayPassNotice { readonly state: "ok" | "missing" | "invalid" | "expired"; readonly enforce_at: string | null; readonly mode?: "grace" | "enforce" }

/**
 * Whether a relay that said `notice` of passes in `sync` enforces them at `now` (ms): in `enforce`, or in `grace` past
 * its `enforce_at`. One that names no mode (a relay from before it did) counts as enforcing only past `enforce_at`,
 * and one that said nothing of passes asks for none.
 */
export function relayEnforcesPasses(notice: RelayPassNotice | null, now: number): boolean {
  return notice !== null && (notice.mode === "enforce" || (notice.enforce_at !== null && now >= Date.parse(notice.enforce_at)));
}

function passNotice(value: unknown): RelayPassNotice | null {
  if (typeof value !== "object" || value === null) return null;
  const { state, enforce_at: at, mode } = value as { state?: unknown; enforce_at?: unknown; mode?: unknown };
  if (state !== "ok" && state !== "missing" && state !== "invalid" && state !== "expired") return null;
  return { state, enforce_at: typeof at === "string" && Number.isFinite(Date.parse(at)) ? at : null, ...(mode === "grace" || mode === "enforce" ? { mode } : {}) };
}

interface DataConnection {
  readonly socket: WebSocket;
  cancelTimeout: () => void;
  readonly sockets: Set<Parameters<RelaySocketHandlers["open"]>[0]>;
  session?: RelaySession;
  cancelKeepalive?: () => void;
  /** Set once the client signed in or paired; until then the connection holds no session place. */
  deviceId?: string;
  /** Gives its signed-in place back (SignedInSessions.admit). */
  release?: () => void;
  /** counts the session as its device's for good: its client opened a stream on it */
  chosen?: () => void;
}

/** The relay's word on a warm socket that a client took: `{"type":"bound","connection_id":"<32 hex>"}`. */
function boundConnection(frame: unknown): string | null {
  if (typeof frame !== "string" || frame.length > 128) return null;
  try {
    const value: unknown = JSON.parse(frame);
    return typeof value === "object" && value !== null && "type" in value && value.type === "bound" && "connection_id" in value
      && typeof value.connection_id === "string" && /^[0-9a-f]{32}$/.test(value.connection_id) ? value.connection_id : null;
  } catch { return null; }
}

/** Physical relay I/O only: admission and dispatch remain in RelaySession. */
export class RelayLink {
  private control: WebSocket | undefined;
  /**
   * A data socket opened and proven before any client came, for the relay to hand the next client
   * (relay/core.ts): that client's handshake then waits for no socket of ours. Only while the current
   * control socket's relay said it takes one.
   */
  private warm: WebSocket | undefined;
  /** The control socket a warm socket is opened under, and the generation its relay named for it. */
  private warmControl: { socket: WebSocket; generation: string } | undefined;
  private warmAttempts = 0;
  private cancelWarmRetry: (() => void) | undefined;
  private readonly data = new Map<string, DataConnection>();
  private stopped = false;
  private attempts = 0;
  private readonly signedIn: SignedInSessions;
  private cancelRetry: (() => void) | undefined;
  private cancelKeepalive: (() => void) | undefined;
  private readonly clock: MuxClock;
  /** The control socket once it answered its challenge: the one a renewed pass goes to. */
  private proven: WebSocket | undefined;
  /** The relay refused this PC for its pass (4402): no retry until a pass comes. */
  private passRefused = false;
  /** The pass the current control socket was opened with. */
  private controlPass: string | null = null;
  /** What this relay last said of passes in `sync`; kept while the control socket reconnects, so a limit holds meanwhile. */
  private notice: RelayPassNotice | null = null;
  /** The control socket the last renewal went out on, and when (the link's clock). */
  private renewed: { socket: WebSocket; at: number } | undefined;
  /** A renewal waiting for the relay's minute since the one before it to pass. */
  private cancelRenewal: (() => void) | undefined;

  constructor(private readonly options: RelayLinkOptions) {
    this.clock = options.clock ?? relayClock;
    this.signedIn = options.sessions ?? new SignedInSessions(MAX_SESSIONS);
  }

  get sessions(): number { return [...this.data.values()].filter((entry) => entry.deviceId && entry.session?.mux.active).length; }

  start(): void { if (!this.stopped && !this.control) this.openControl(); }

  private socket(connectionId?: string, warm?: string): WebSocket {
    const url = new URL("/v1/ws", this.options.relay);
    url.searchParams.set("server_id", this.options.identity.server_id);
    url.searchParams.set("role", "server");
    url.searchParams.set("v", "1");
    url.searchParams.set("proof", "1");
    url.searchParams.set("public_key", bytesToHex(importPublicKey(this.options.identity.public_key)));
    if (connectionId) url.searchParams.set("connection_id", connectionId);
    if (warm) url.searchParams.set("warm", warm);
    const pass = this.options.pass?.() ?? null;
    if (!connectionId && !warm) this.controlPass = pass;
    const headers = pass === null ? undefined : { [RELAY_PASS_HEADER]: pass };
    // Bun's WebSocket takes headers (never the URL: a pass is good for hours)
    return (this.options.connect ?? ((address, extra) => new WebSocket(address, (extra ? { headers: extra } : undefined) as unknown as string[])))(url.href, headers);
  }

  /**
   * A new pass: sent on the proven control socket, or, after a refusal for the pass, a new control socket opens with it.
   * One that follows another within the relay's minute waits for it to pass and then goes out as the pass held by
   * then: the relay would drop it unanswered, and go on holding this PC to the older pass (whether new client
   * sessions are allowed included) until the next renewal, half a day later.
   */
  renewPass(pass: string): void {
    if (this.stopped) return;
    if (this.passRefused) {
      this.passRefused = false;
      if (!this.control) this.openControl();
      return;
    }
    // without one, the next control socket opens with the pass held then
    const control = this.proven;
    if (!control || control !== this.control) return;
    this.cancelRenewal?.();
    this.cancelRenewal = undefined;
    const wait = this.renewed?.socket === control ? this.renewed.at + RENEWAL_GAP_MS - this.clock.now() : 0;
    if (wait > 0) {
      this.cancelRenewal = this.clock.setTimeout(() => {
        this.cancelRenewal = undefined;
        const latest = this.options.pass ? this.options.pass() : pass;
        if (latest !== null) this.renewPass(latest);
      }, wait);
      return;
    }
    this.renewed = { socket: control, at: this.clock.now() };
    control.send(JSON.stringify({ type: "relay_pass", pass }));
  }

  private openControl(): void {
    if (this.stopped) return;
    this.options.onState("connecting", null);
    let socket: WebSocket;
    try { socket = this.socket(); }
    catch { this.retry(); return; }
    this.control = socket;
    let proofAnswered = false;
    let lastPong = this.clock.now();
    // An upgrade that never answers is also a lost relay.
    this.cancelKeepalive = this.clock.setTimeout(() => socket.close(), 15_000);
    socket.onopen = () => {
      if (this.stopped || this.control !== socket) { socket.close(); return; }
      this.cancelKeepalive?.();
      lastPong = this.clock.now();
      const heartbeat = () => {
        if (this.stopped || this.control !== socket) return;
        if (this.clock.now() - lastPong >= 30_000) { socket.close(); return; }
        if (proofAnswered) socket.send('{"type":"ping"}');
        this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
      };
      this.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    socket.onmessage = (event) => {
      if (this.stopped || this.control !== socket || typeof event.data !== "string") return;
      // Bounded before parsing; no rate limit, since client arrivals and departures drive this traffic.
      if (event.data.length > CONTROL_MESSAGE_BYTES) { socket.close(); return; }
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "control", null);
        if (proofAnswered) this.proven = socket;
        return;
      }
      let value: unknown;
      try { value = JSON.parse(event.data); } catch { socket.close(); return; }
      if (typeof value !== "object" || value === null || !("type" in value)) { socket.close(); return; }
      if (value.type === "pong") { lastPong = this.clock.now(); return; }
      if (value.type === "sync" && "connection_ids" in value && Array.isArray(value.connection_ids)
        && value.connection_ids.length <= 8 && value.connection_ids.every((id) => typeof id === "string" && /^[0-9a-f]{32}$/.test(id))) {
        this.attempts = 0;
        this.options.onState("online", null);
        this.notice = "relay_pass" in value ? passNotice(value.relay_pass) : null;
        this.options.onPassNotice?.(this.notice);
        // a pass that came while this socket was being let in found none to go out on: the socket opened with the one
        // before. One that came once the proof was answered went out as a renewal already
        const held = this.options.pass?.() ?? null;
        if (held !== null && held !== this.controlPass && this.renewed?.socket !== socket) this.renewPass(held);
        for (const id of value.connection_ids) this.openData(id);
        if ("warm" in value && typeof value.warm === "string" && /^[0-9a-f]{32}$/.test(value.warm)) {
          this.warmControl = { socket, generation: value.warm };
          this.openWarm();
        }
      } else if ("connection_id" in value && typeof value.connection_id === "string" && /^[0-9a-f]{32}$/.test(value.connection_id)) {
        if (value.type === "connected") this.openData(value.connection_id);
        else if (value.type === "disconnected") this.data.get(value.connection_id)?.socket.close();
        else socket.close();
      } else socket.close();
    };
    socket.onerror = () => socket.close();
    socket.onclose = (event) => {
      if (this.control !== socket) return;
      this.control = undefined;
      if (this.proven === socket) this.proven = undefined;
      // a renewal that waited goes with the next control socket, which opens with the pass held then
      this.cancelRenewal?.();
      this.cancelRenewal = undefined;
      this.cancelKeepalive?.();
      this.endWarm();
      // The relay also uses 4401 for late answers. Only an explicit key mismatch is permanent.
      if (event.code === SERVER_PROOF_CLOSE && PERMANENT_SERVER_PROOF_REFUSALS.includes(event.reason)) {
        console.error(JSON.stringify({ event: "relay.server_proof.failed", code: event.code, reason: event.reason }));
        this.options.onState("error", `Relay refused the server proof (${event.code}): ${event.reason}`, "server_key_refused");
        return;
      }
      // refused for the pass: asking again without a new one would be refused again (renewPass reopens)
      if (event.code === RELAY_PASS_CLOSE) {
        // a pass came while this socket was being let in: try again with it, it was not the one refused
        const held = this.options.pass?.() ?? null;
        if (held !== null && held !== this.controlPass) { if (!this.stopped) this.retry(); return; }
        this.passRefused = true;
        this.options.onPassRefused?.();
        // a relay moved back to grace or off lets the PC in without a pass: look again now and then
        this.cancelRetry = this.clock.setTimeout(() => { if (this.passRefused && !this.control) { this.passRefused = false; this.openControl(); } }, PASS_REFUSED_RETRY_MS);
        this.options.onState("error", `The Ovis relay needs a signed-in account (${event.reason || "relay pass required"}).`, "pass_required");
        return;
      }
      if (!this.stopped) this.retry();
    };
  }

  private prove(socket: WebSocket, frame: unknown, role: "control" | "data" | "warm", connectionId: string | null): boolean {
    const answer = answerServerChallenge(frame, importSecretKey(this.options.identity.secret_key), {
      server_id: this.options.identity.server_id, role, connection_id: connectionId,
    });
    if (!answer) { socket.close(4000, "invalid relay server challenge"); return false; }
    socket.send(answer);
    return true;
  }

  private retry(): void {
    if (this.stopped) return;
    this.options.onState("error", "Relay connection lost; reconnecting.", "relay_unreachable");
    const delay = Math.round(Math.min(++this.attempts, 30) * 1000 * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.cancelRetry = this.clock.setTimeout(() => this.openControl(), delay);
  }

  /** Whether one more client may start signing in; the relay bounds who reaches this PC (relay/core.ts: MAX_CLIENTS answered, MAX_PENDING waiting). */
  private hasRoom(id: string): boolean {
    if (this.stopped || this.data.has(id)) return false;
    // a client still signing in holds no session place and is closed at its deadline (serveData)
    if (this.data.size >= MAX_SESSIONS + MAX_PENDING) return false;
    return [...this.data.values()].filter((entry) => entry.deviceId).length < MAX_SESSIONS;
  }

  private openData(id: string): void {
    if (!this.hasRoom(id)) return;
    let socket: WebSocket;
    try { socket = this.socket(id); } catch { return; }
    socket.binaryType = "arraybuffer";
    this.serveData(id, socket, false);
  }

  private openWarm(): void {
    const control = this.warmControl;
    if (this.stopped || this.warm || this.cancelWarmRetry || !control || control.socket !== this.control) return;
    let socket: WebSocket;
    try { socket = this.socket(undefined, control.generation); } catch { this.retryWarm(); return; }
    socket.binaryType = "arraybuffer";
    this.warm = socket;
    let proofAnswered = false;
    let lastHeard = this.clock.now();
    let cancelKeepalive: (() => void) | undefined;
    // Given up on (it stalled, or closed): another is opened after a pause, without waiting for a close
    // event a half-open socket may never deliver.
    const abandon = () => {
      cancelKeepalive?.();
      if (this.warm !== socket) return;
      this.warm = undefined;
      socket.close();
      if (this.control === control.socket) this.retryWarm();
    };
    // As the control socket: a socket the relay has not answered for 30 s (its upgrade, challenge or pong) is lost.
    const heartbeat = () => {
      if (this.warm !== socket) return;
      if (this.clock.now() - lastHeard >= 30_000) { abandon(); return; }
      if (proofAnswered) socket.send('{"type":"ping"}');
      cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    socket.onmessage = (event) => {
      if (this.warm !== socket) return;
      lastHeard = this.clock.now();
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "warm", control.generation);
        return;
      }
      if (event.data === '{"type":"pong"}') return;
      const id = boundConnection(event.data);
      if (!id) { socket.close(); return; }
      cancelKeepalive?.();
      this.warm = undefined;
      this.warmAttempts = 0;
      // the client's frames follow on this socket: its handshake consumer is installed before this returns
      if (this.hasRoom(id)) this.serveData(id, socket, true);
      else socket.close();
      this.openWarm();
    };
    socket.onerror = abandon;
    socket.onclose = abandon;
  }

  /** Another warm socket after a pause that grows as the control link's does; clients are served through `connected` meanwhile. */
  private retryWarm(): void {
    if (this.stopped || this.cancelWarmRetry) return;
    const delay = Math.round(Math.min(++this.warmAttempts, 30) * 1000 * (0.8 + (this.options.random ?? Math.random)() * 0.4));
    this.cancelWarmRetry = this.clock.setTimeout(() => { this.cancelWarmRetry = undefined; this.openWarm(); }, delay);
  }

  private endWarm(): void {
    this.cancelWarmRetry?.();
    this.cancelWarmRetry = undefined;
    this.warmControl = undefined;
    this.warmAttempts = 0;
    const warm = this.warm;
    this.warm = undefined;
    warm?.close();
  }

  /** One client's data socket, whether opened for it or a warm socket it took (`proven`, already open). */
  private serveData(id: string, socket: WebSocket, proven: boolean): void {
    // Runs until the client signs in or pairs, not just until the protected channel opens.
    const deadline = () => {
      // A pairing may already be saved: let its acknowledgment through once, then close regardless.
      if (entry.session?.verifying) entry.cancelTimeout = this.clock.setTimeout(() => socket.close(), SIGN_IN_GRACE_MS);
      // a comparison of digits ends the session itself at PAIR_APPROVAL_MS; this is only the backstop
      else if (entry.session?.pairing) entry.cancelTimeout = this.clock.setTimeout(deadline, PAIR_APPROVAL_MS);
      else socket.close();
    };
    const entry: DataConnection = { socket, sockets: new Set(), cancelTimeout: this.clock.setTimeout(deadline, 15_000) };
    this.data.set(id, entry);
    // The relay refuses a client outright once 8 are answered, before this PC hears of it, so a room full
    // of clients that never sign in would turn everyone away. Keep a place free: the oldest client not
    // signed in gives way to a new one. A signed-in session is never evicted.
    if (this.data.size >= MAX_SESSIONS) {
      // a phone comparing digits waits for a person: it gives way last
      const waiting = [...this.data].filter(([other, candidate]) => other !== id && !candidate.deviceId);
      const oldest = waiting.find(([, candidate]) => !candidate.session?.pairing) ?? waiting[0];
      if (oldest) {
        this.data.delete(oldest[0]);
        oldest[1].socket.close();
      }
    }
    let proofAnswered = proven;
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      send: (data) => { socket.send(data); },
      close: (code, reason) => socket.close(code, reason),
    };
    socket.onmessage = (event) => {
      if (!proofAnswered) {
        proofAnswered = this.prove(socket, event.data, "data", id);
        return;
      }
      if (event.data === '{"type":"pong"}') return;
      if (typeof event.data === "string" || event.data instanceof ArrayBuffer) {
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
      } else socket.close();
    };
    socket.onerror = () => { transport.onerror?.(new Error("Relay data connection failed")); socket.close(); };
    socket.onclose = (event) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      transport.onclose?.(event.code, event.reason);
      entry.release?.();
      if (this.data.get(id) === entry) this.data.delete(id);
    };
    const heartbeat = () => {
      if (this.stopped || this.data.get(id) !== entry) return;
      if (proofAnswered) socket.send('{"type":"ping"}');
      entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    };
    if (proven) entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000);
    else socket.onopen = () => { entry.cancelKeepalive = this.clock.setTimeout(heartbeat, 10_000); };
    // Install the handshake consumer before the data socket can receive held client frames.
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: {
        publicKey: importPublicKey(this.options.identity.public_key),
        secretKey: importSecretKey(this.options.identity.secret_key),
      },
      events: { onmessage: (data) => { if (!this.stopped) entry.session?.receive(data); } },
    }).then((channel) => {
      if (this.stopped || this.data.get(id) !== entry || !channel.isOpen()) { channel.close(); return; }
      const handlers = this.options.services.core.socketHandlers;
      entry.session = new RelaySession({
        channel, services: this.options.services, port: this.options.port, serverId: this.options.identity.server_id,
        serverVersion: this.options.serverVersion ?? version, minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024,
        onAuthenticated: (deviceId) => this.authenticated(id, entry, deviceId),
        onChosen: () => entry.chosen?.(),
        refuseNewDevice: () => this.refuseNewDevice(id, entry),
        ...(this.options.relayHints ? { relayHints: this.options.relayHints } : {}),
        ...(this.options.directCarriers ? { directCarriers: this.options.directCarriers } : {}),
        websocket: {
          ...handlers,
          open: (peer) => { entry.sockets.add(peer); return handlers.open(peer); },
          close: (peer, code, reason) => { entry.sockets.delete(peer); handlers.close(peer, code, reason); },
        },
      });
    }).catch(() => socket.close());
  }

  /**
   * Whether this relay refuses new client sessions to this PC now: it enforces passes (relayEnforcesPasses), and the
   * pass it may hold this PC to is a v2 pass that says `new` 0 (shared/relay-pass.ts). That pass is the latest this PC
   * was given, whether or not it reached the relay yet (a renewal waits its turn, a control socket reconnects): the
   * relay refuses only whom this PC names, so what the PC holds decides, and a relay still holding an older pass
   * refuses nobody by itself. How long the pass counts is its keeper's to say (`honoredPass`), not read from its `exp`
   * against this PC's clock.
   */
  private refusesNewDevices(): boolean {
    if (!relayEnforcesPasses(this.notice, (this.options.now ?? Date.now)())) return false;
    const payload = parseRelayPass((this.options.honoredPass ?? this.options.pass)?.() ?? null)?.payload;
    return payload !== undefined && !relayPassAdmitsNewSessions(payload);
  }

  /**
   * A pairing on this client's session would make a device new to this PC (RelaySession refuseNewDevice). While the
   * relay refuses new sessions, the PC names the client on its control socket and the relay closes it `4403`
   * (relay/README.md, "New sessions"); the PC makes no device either way, and closes the data socket itself should
   * the relay not. Nothing is said before that: a client that only knows the server_id learns nothing of the pass.
   */
  private refuseNewDevice(id: string, entry: DataConnection): boolean {
    if (this.data.get(id) !== entry || !this.refusesNewDevices()) return false;
    if (this.proven && this.proven === this.control) this.proven.send(JSON.stringify({ type: "new_session", connection_id: id }));
    entry.cancelTimeout();
    entry.cancelTimeout = this.clock.setTimeout(() => entry.socket.close(), NEW_SESSION_CLOSE_MS);
    return true;
  }

  private authenticated(id: string, entry: DataConnection, deviceId: string): void {
    if (this.data.get(id) !== entry) return;
    entry.cancelTimeout();
    entry.deviceId = deviceId;
    const line = entry.session ? { route: "relay" as const, relay: this.options.relay, since: Date.now(), mux: entry.session.mux } : undefined;
    // an app racing its carriers drops all but one: only the one it uses makes its device's older sessions give way
    const admission = this.signedIn.candidate(deviceId, () => entry.session?.close("resource_exhausted"), line);
    entry.release = admission.release;
    entry.chosen = admission.chosen;
  }

  /** Cancel retries synchronously; finish queued policy closes before ending protected carriers. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRetry?.();
    this.cancelKeepalive?.();
    this.cancelRenewal?.();
    this.endWarm();
    const control = this.control;
    this.control = undefined;
    await Promise.all([...this.data.values()].map(async (entry) => {
      entry.cancelTimeout();
      entry.cancelKeepalive?.();
      for (const socket of entry.sockets) socket.close(1001, "Relay stopped");
      if (entry.session) {
        await entry.session.mux.flush();
        entry.session.mux.goAway("shutdown", 0);
        await entry.session.mux.flush();
      }
      entry.socket.close();
      entry.release?.();
    }));
    control?.close();
    this.data.clear();
  }
}
