/**
 * Another PC added through the Ovis relay, with no SSH (docs/remote-pcs.md, "Through the relay"). This server pairs
 * with that PC's Ovis the way a phone does (shared/relay-channel.ts: Noise NK, Ovis Mux v1, a device key it signs
 * in with), and that PC sees it as one more paired device it can revoke. A loopback forward then gives the PC the
 * same `{ url, token }` endpoint an SSH local forward gives (machines.ts), so everything that reads a remote PC
 * through its endpoint (its roster, status socket, API routes and terminals) runs unchanged over the relay.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { DirectCarrierUnusableError, openRelayChannel, openRelayChannelWithFallback, orderDirectRoutes, probeDirect, UnsafeRelayDestinationError } from "../shared/relay-channel.ts";
import type { RelayChannelOptions } from "../shared/relay-channel.ts";
import type { RelayChannel, RelaySocket } from "../shared/relay-channel.ts";
import { base64url, ServerIdentityChangedError } from "../shared/relay-device.ts";
import type { RelayDevice, RelayDeviceStore } from "../shared/relay-device.ts";
import { MuxStreamError } from "../shared/relay-mux-engine.ts";
import type { HttpRequest, WsStream } from "../shared/relay-mux-engine.ts";
import { isDirectCarrier, MAX_DIRECT_CARRIERS, MAX_LARGE_WS_MESSAGE_BYTES, MuxProtocolError, PAIR_INTENT_VOUCHED, REQUEST_HEADERS } from "../shared/relay-mux.ts";
import type { RelayOffer } from "../shared/relay-offer.ts";
import { validateOffer } from "../shared/relay-offer.ts";
import { OUTPUT_STALLED_CLOSE_CODE } from "../shared/terminal-flow.ts";
import { OUTPUT_HARD_BYTES } from "./output-window.ts";
import { writePrivateState } from "./private-state.ts";

/** The other PC refused this one for good (revoked, never paired, a new identity or protocol): retrying cannot help. */
export class RelayPcRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RelayPcRefused";
  }
}

/** The other PC answered, and its Ovis cannot pair with another PC of the account (PAIR_INTENT_VOUCHED): nothing was sent to pair. */
export class RelayPcOutdated extends Error {
  constructor() {
    super("Update Ovis on that PC first.");
    this.name = "RelayPcOutdated";
  }
}

/** The port a PC's direct listener asks for first (server/relay/direct.ts DIRECT_PORT, not imported: that module listens). */
const DIRECT_LISTENER_PORT = 7319;

/**
 * Whether this server dials a carrier another PC named (docs/remote-pcs.md): an address on a private network (RFC
 * 1918) or Tailscale's, on the port a direct listener asks for (7319). Never link-local, where a cloud's metadata
 * service answers, and never another port: no other port can be told apart from some other service's, so a PC whose
 * listener had to take another one is reached through the relay. The protocol takes more (shared/relay-mux.ts
 * isDirectCarrier), so an AUTH_OK that names more is still read; only the dialing is narrower.
 */
export function serverDialable(carrier: string): boolean {
  if (!isDirectCarrier(carrier)) return false;
  const { hostname, port } = new URL(carrier);
  return !hostname.startsWith("169.254.") && Number(port) === DIRECT_LISTENER_PORT;
}

/**
 * What a PC's direct routes last showed, kept per PC across its tunnels by the caller, so a connection that keeps
 * dropping (a relay that ends it, say) does not dial them again on each return: when they were last tried, how much
 * longer the next try waits, whether that try found none answering, and the network this PC was on then.
 */
export interface RouteProbes { at: number; backoff: number; failed: boolean; network?: string; wallAt?: number }
export function newRouteProbes(): RouteProbes { return { at: -Infinity, backoff: 1, failed: false }; }
/** Notes a try now, on both clocks: the monotonic one may stand still while the PC sleeps. */
function tried(probes: RouteProbes): void { probes.at = performance.now(); probes.wallAt = Date.now(); }
/** Whether this PC slept since the last try: much more wall-clock time passed than monotonic time. */
function sleptSince(probes: RouteProbes): boolean {
  return probes.wallAt !== undefined && (Date.now() - probes.wallAt) - (performance.now() - probes.at) > 60_000;
}

export function relayPcLabel(): string { return `Ovis on ${hostname()}`.slice(0, 64); }

interface SavedKey {
  v: 1;
  offer: RelayOffer;
  device_id: string;
  label: string;
  public_spki: string;
  /** P-256 private key, PKCS#8, base64url: this server's only secret for that PC */
  private_pkcs8: string;
  /** the PC's direct carriers its last AUTH_OK named: where the next connection tries first */
  direct?: string[];
}

/**
 * One relay PC's device key, in its own file (mode 0600). A new key lives in memory until the other PC admits it
 * (channel.ts saves a first pairing's key only on AUTH_OK), so a pairing that fails leaves nothing behind.
 */
export class RelayPcKey implements RelayDeviceStore {
  /** `wanted`: whether the PC is still this server's; a pairing or sign-in finishing after its removal writes no key */
  private constructor(private readonly path: string, private device: RelayDevice, private readonly pkcs8: string, private readonly wanted: () => boolean) {}

  static async create(path: string, offer: RelayOffer, wanted: () => boolean, label = relayPcLabel()): Promise<RelayPcKey> {
    const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pkcs8 = base64url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey)));
    const { code: _code, ...saved } = offer;
    return new RelayPcKey(path, {
      server_id: saved.server_id, server_public_key: saved.server_public_key, relay: saved.relay,
      ...(saved.name === undefined ? {} : { name: saved.name }),
      device_id: null, label, private_key: await signingKey(pkcs8),
      public_spki: base64url(new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey))),
    }, pkcs8, wanted);
  }

  static async load(path: string, wanted: () => boolean): Promise<RelayPcKey> {
    const saved = JSON.parse(readFileSync(path, "utf8")) as SavedKey;
    if (saved?.v !== 1 || typeof saved.device_id !== "string" || typeof saved.private_pkcs8 !== "string"
      || typeof saved.public_spki !== "string" || typeof saved.label !== "string") throw new Error("Invalid relay PC key");
    const offer = validateOffer(saved.offer);
    // only carriers this server dials (serverDialable): anything else in the file is not an address to dial
    const direct = Array.isArray(saved.direct) ? saved.direct.filter((carrier) => typeof carrier === "string" && serverDialable(carrier)).slice(0, MAX_DIRECT_CARRIERS) : [];
    return new RelayPcKey(path, {
      server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
      ...(offer.name === undefined ? {} : { name: offer.name }),
      ...(direct.length === 0 ? {} : { direct }),
      device_id: saved.device_id, label: saved.label, public_spki: saved.public_spki,
      private_key: await signingKey(saved.private_pkcs8),
    }, saved.private_pkcs8, wanted);
  }

  /** The PC as the relay names it, without any pairing code: what a reconnect signs in to. */
  get offer(): RelayOffer {
    const { server_id, server_public_key, relay, name } = this.device;
    return { v: 1, server_id, server_public_key, relay, ...(name === undefined ? {} : { name }) };
  }

  get paired(): boolean { return this.device.device_id !== null; }

  /** The PC's direct carriers as its last AUTH_OK named them. */
  get direct(): readonly string[] { return this.device.direct ?? []; }

  async get(serverId: string): Promise<RelayDevice | undefined> {
    return serverId === this.device.server_id ? this.device : undefined;
  }

  async update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice> {
    if (serverId !== this.device.server_id) throw new Error("Relay PC key names another PC");
    // the current one is handed over only once admitted: a new key is a pairing that channel.ts saves on AUTH_OK
    const next = change(this.device.device_id === null ? undefined : this.device);
    if (next.device_id === null) throw new Error("Relay PC was not admitted");
    if (!this.wanted()) throw new Error("Relay PC was removed");
    const { server_id, server_public_key, relay, name } = next;
    // the offer from `next`: a relay the PC named in AUTH_OK (relay-hints) is kept across a restart too
    const offer: RelayOffer = { v: 1, server_id, server_public_key, relay, ...(name === undefined ? {} : { name }) };
    // what the PC named that this server would not dial is not kept either
    const direct = next.direct?.filter(serverDialable) ?? [];
    writePrivateState(this.path, {
      v: 1, offer, device_id: next.device_id, label: next.label, public_spki: next.public_spki, private_pkcs8: this.pkcs8,
      ...(direct.length ? { direct } : {}),
    } satisfies SavedKey);
    this.device = { ...next, direct };
    return this.device;
  }

  async list(): Promise<RelayDevice[]> { return [this.device]; }

  async remove(): Promise<void> { removeRelayPcKey(this.path); }
}

async function signingKey(pkcs8: string): Promise<CryptoKey> {
  const bytes = Uint8Array.from(atob(pkcs8.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", bytes, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export function removeRelayPcKey(path: string): void {
  try { unlinkSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface RelayPcTunnel {
  /** what machines.ts reads a remote PC through, as an SSH forward gives it */
  readonly endpoint: { url: string; token: string };
  /** how the connection reaches the PC now: through the relay, or on one of its direct carriers */
  readonly route: "relay" | "direct";
  close(): void;
}

/** Whether another attempt could only fail the same way (as the hosted app's isFatalRelayError). */
function fatal(error: unknown): error is Error {
  if (error instanceof ServerIdentityChangedError || error instanceof UnsafeRelayDestinationError) return true;
  return error instanceof MuxProtocolError && ["auth_revoked", "auth_failed", "unsupported_version", "unsupported_extension", "unsupported_transport"].includes(error.code);
}

/** How long a request waits for one of the session's stream places (32, docs/relay.md Limits) before it fails. */
const STREAM_WAIT_MS = 30_000;
const METHODS: readonly string[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** How long a connection tries the PC's direct carriers before the relay, as the app's (src/lib/relay/transport.ts). */
const DIRECT_BUDGET_MS = 1_500;
/** While a later route carries the channel, earlier ones are checked at most this often, unless the network changed. */
const PROBE_EVERY_MS = 5 * 60_000;
/** How often this PC's own addresses are read to notice a network change (a local read, nothing sent). */
const NETWORK_CHECK_MS = 30_000;
/** A move waits for no request under way and no WebSocket that sent anything for this long, checked this often, this many times. */
const QUIET_MS = 3_000;
const IDLE_CHECK_MS = 5_000;
const IDLE_CHECKS = 12;

/** This PC's own IPv4 addresses, which change when it joins another network (or Tailscale comes up). */
function networkNow(): string {
  return Object.values(networkInterfaces()).flatMap((list) => list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal).map((entry) => entry.address).sort().join(",");
}

/** `pending`: not yet accepted by the PC, or closed: counted as busy (a move waits) until then */
interface Forwarded { target: string; remote?: WsStream; open: boolean; pending: boolean; waiting: (string | Uint8Array)[]; waitingBytes: number; closed: boolean; abort: AbortController }

/** What a socket may send before the other PC accepted its stream; past it the socket closes (1009). */
const WAITING_BYTES = 1024 * 1024;

/** A close code a server-side socket may send: the relay's own (1006) and reserved ones become 1011. */
function sendableClose(code: number): number {
  return code === 1000 || code === 1001 || code === 1008 || code === 1011 || code === 1012 || (code >= 3000 && code <= 4999) ? code : 1011;
}

/**
 * Connects to the PC (pairing with the offer's code the first time, signing in with the saved key after), then
 * serves it on 127.0.0.1 behind a random token: each request and WebSocket becomes a stream of the one mux session.
 *
 * Routes, best first: the PC's direct carriers (docs/relay.md "Direct on the same network"; same-network addresses
 * before Tailscale ones), then the relay. A sign-in tries the carriers the PC last named (kept with the key) within
 * DIRECT_BUDGET_MS, then the relay. While a later route carries it, the earlier ones are probed (Noise to the pinned
 * key, no session) after admission, then at most every PROBE_EVERY_MS, and at once when this PC's addresses change or
 * it wakes from sleep. Once one proves to be the PC and the tunnel is idle, a session is opened there first, then the
 * old one is closed: `onMoved` tells the caller its streams on the old route ended, with nothing lost.
 * `onLost` fires once when the connection ends; the caller decides whether to try again (a RelayPcRefused never
 * should). Never retries by itself.
 */
export async function openRelayPcTunnel(offer: RelayOffer, key: RelayPcKey, options: {
  socket?: (url: string) => RelaySocket;
  /** how this PC dials the PC's direct carriers; plain WebSockets (which send no Origin) by default */
  directSocket?: (url: string) => RelaySocket;
  onLost: (error: Error) => void;
  onMoved?: () => void;
  /** this PC's own addresses as one string that changes with them (networkNow by default), and how often it is read */
  network?: () => string;
  networkCheckMs?: number;
  /** this PC's probe deadline, kept by the caller across its tunnels; a tunnel of its own by default */
  probes?: RouteProbes;
  /**
   * A first pairing with another PC of the account (PAIR_INTENT_VOUCHED) instead of a code: `compare` is told the
   * digits, a PC that does not select the intent is RelayPcOutdated before anything is sent to pair, and `signal`
   * ends the comparison. The caller never aborts it once the tunnel is open: it would end the admitted channel too.
   */
  pairing?: { compare: (digits: string) => Promise<void>; signal: AbortSignal };
}): Promise<RelayPcTunnel> {
  const readNetwork = options.network ?? networkNow;
  const networkCheckMs = options.networkCheckMs ?? NETWORK_CHECK_MS;
  const probes = options.probes ?? newRouteProbes();
  // this PC on another network than at the last try: the PC's routes may answer now, whatever that try found
  const startNetwork = readNetwork();
  // or after a sleep, which may end on another network with the same addresses
  if ((probes.network !== undefined && probes.network !== startNetwork) || sleptSince(probes)) Object.assign(probes, newRouteProbes());
  probes.network = startNetwork;
  /** whether a sign-in tries the direct routes: none was found silent from the relay, or the wait after that is over */
  const due = (): boolean => !probes.failed || probes.at + PROBE_EVERY_MS * probes.backoff <= performance.now();
  const directSocket = options.directSocket ?? ((url: string) => new WebSocket(url) as unknown as RelaySocket);
  // a pairing's one-time code is spent once admitted: every channel after the first signs in with the key
  const { code: _code, ...signIn } = offer;
  let closed = false;
  let lost = (error: Error): void => { void error; };
  /** the channel that carries new streams; only its end is the connection's loss */
  let current: RelayChannel | undefined;
  /** ends every attempt and probe under way when the tunnel closes */
  const ending = new AbortController();
  /** a move is opening its new session: new streams wait for it, and the old session's end is the move's to settle */
  let moving: Promise<void> | undefined;
  /** how the old session ended while a move opened its replacement (the PC may let only so many sessions of a key in) */
  let replaced: Error | undefined;
  const label = (await key.list())[0]!.label;
  const base = (): RelayChannelOptions => ({
    store: key, label,
    // whoever asks through the forward sets the deadline (the machine proxy: 75 s, 165 s for its slow routes)
    // a server can dial a Tailscale address whenever this PC is on Tailscale, and fails fast when not: always asked
    // for, so the carriers kept with the key stay right when Tailscale comes and goes
    requestTimeoutMs: () => 0, offerDirect: true, offerTailnet: true,
  });
  /**
   * A channel on `direct` within `ms`, or through the relay; its end counts as the connection's only while it is the
   * current one, or the one a move is replacing (that move then settles it). The deadline is the admission's only:
   * an aborted signal ends an admitted channel too, so it is never handed to the channel itself.
   */
  const openOn = async (direct: string | undefined, ms = 0): Promise<RelayChannel> => {
    let channel: RelayChannel | undefined;
    const settings: RelayChannelOptions = { ...base(), onClose: (error) => {
      if (channel === undefined || channel !== current) return;
      if (moving) { replaced = error; return; }
      lost(error);
    } };
    if (direct === undefined) {
      // only the first channel pairs: every one after it signs in with the key that pairing admitted
      const pairing = options.pairing !== undefined && !paired ? vouchedPairing(options.pairing) : {};
      paired = true;
      return channel = (await openRelayChannelWithFallback(offer, { ...settings, ...pairing, ...(options.socket ? { socket: options.socket } : {}) }, openRelayChannel)).channel;
    }
    const attempt = new AbortController();
    const stop = (): void => attempt.abort();
    const timer = setTimeout(stop, ms);
    ending.signal.addEventListener("abort", stop, { once: true });
    try {
      channel = await openRelayChannel(signIn, { ...settings, direct, socket: directSocket, signal: attempt.signal });
    } finally {
      clearTimeout(timer);
      ending.signal.removeEventListener("abort", stop);
    }
    // admitted: from here only its own end or this tunnel's close ends it, never the attempt's deadline
    return channel;
  };
  let paired = false;
  /** the carriers the PC named last, and the one that last carried the channel */
  let learned: readonly string[] = key.direct;
  let worked: string | undefined;
  const routes = (): string[] => orderDirectRoutes(learned, worked);
  /** The channel on the first direct carrier that admits this PC within DIRECT_BUDGET_MS; undefined when none does. */
  const openDirect = async (): Promise<RelayChannel | undefined> => {
    const carriers = routes();
    if (carriers.length === 0 || !due()) return undefined;
    const ends = performance.now() + DIRECT_BUDGET_MS;
    for (const [index, direct] of carriers.entries()) {
      const left = ends - performance.now();
      if (left <= 0) break;
      // a carrier that stays silent takes only its share, so the ones after it still get a turn
      try {
        const channel = await openOn(direct, Math.max(1, left / (carriers.length - index)));
        probes.failed = false;
        return channel;
      } catch (error) {
        // the PC itself refused after Noise proved it: final here as through the relay
        if (fatal(error) && !(error instanceof DirectCarrierUnusableError)) throw error;
      }
    }
    // none answered: this counts as the check, so the relay's admission does not probe them again at once
    tried(probes);
    probes.failed = true;
    return undefined;
  };
  try {
    // a pairing goes through the relay only; a sign-in tries the PC's own network first
    current = (offer.code === undefined && options.pairing === undefined ? await openDirect() : undefined) ?? await openOn(undefined);
  } catch (error) {
    throw fatal(error) ? new RelayPcRefused(refusal(error, offer.code !== undefined || options.pairing !== undefined), { cause: error }) : error;
  }
  const waiting = new Set<() => void>();
  /** HTTP streams under way and sockets not yet accepted by the PC: a move waits for none */
  let busy = 0;
  /** of those, the ones waiting for a move to settle (they open on whichever session it leaves) */
  let waitingForMove = 0;
  let sentAt = -Infinity;
  const install = (channel: RelayChannel): void => {
    current = channel;
    learned = (channel.directCarriers ?? learned).filter(serverDialable);
    if (channel.direct !== undefined) worked = channel.direct;
    channel.mux.onStreamAvailable = () => { for (const wake of [...waiting]) wake(); };
  };
  install(current);
  /** Opens a stream, waiting its turn while every place is taken, as the hosted app's requests do. */
  const opened = async <T>(open: () => T, signal: AbortSignal): Promise<T> => {
    const deadline = performance.now() + STREAM_WAIT_MS;
    for (;;) {
      signal.throwIfAborted();
      try { return open(); } catch (error) {
        if (closed || !(error instanceof MuxStreamError && error.code === "refused")) throw error;
        await new Promise<void>((resolve, reject) => {
          const done = (): void => { clearTimeout(timer); waiting.delete(wake); signal.removeEventListener("abort", aborted); };
          const wake = (): void => { done(); resolve(); };
          const aborted = (): void => { done(); reject(signal.reason); };
          const timer = setTimeout(() => { done(); reject(new Error("No relay stream place came free")); }, Math.max(0, deadline - performance.now()));
          waiting.add(wake);
          signal.addEventListener("abort", aborted, { once: true });
        });
      }
    }
  };
  const forward = async (request: Request, target: string): Promise<Response> => {
    if (!METHODS.includes(request.method)) return new Response(null, { status: 405 });
    const allowed: readonly string[] = REQUEST_HEADERS;
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    busy++;
    let released = false;
    const release = (): void => { if (!released) { released = true; busy--; } };
    try {
      // never onto the session a move is about to close
      while (moving) { waitingForMove++; try { await moving; } finally { waitingForMove--; } }
      const stream = await opened(() => current!.mux.openHttp({
        target, method: request.method as HttpRequest["method"], body: body ? "stream" : "none",
        headers: [...request.headers].filter(([name]) => allowed.includes(name)),
      }), request.signal);
      return await new Promise<Response>((resolve, reject) => {
        const aborted = (): void => { stream.reset(); reject(request.signal.reason); };
        request.signal.addEventListener("abort", aborted, { once: true });
        if (request.signal.aborted) { aborted(); return; }
        stream.onDispose = (error) => {
          release();
          request.signal.removeEventListener("abort", aborted);
          if (error) reject(error);
        };
        stream.onHeaders = ({ status, headers }) => {
          if (status >= 200) resolve(new Response(stream.noBody ? null : stream.body, { status, headers: headers.map(([name, value]) => [name, value]) }));
        };
        if (body) void stream.sendBody(body).catch(() => { if (stream.live) stream.reset("internal_error"); });
      });
    } catch (error) {
      release();
      throw error;
    }
  };
  const settle = (local: Bun.ServerWebSocket<Forwarded>): void => { if (local.data.pending) { local.data.pending = false; busy--; } };
  const connect = async (local: Bun.ServerWebSocket<Forwarded>): Promise<void> => {
    let remote: WsStream;
    while (moving) { waitingForMove++; try { await moving; } finally { waitingForMove--; } }
    try { remote = await opened(() => current!.mux.openWs({ target: local.data.target, headers: [], protocols: [] }), local.data.abort.signal); }
    catch { settle(local); local.close(1012, "PC connection lost"); return; }
    if (local.data.closed) { remote.close(1000); return; }
    local.data.remote = remote;
    remote.onAccept = () => {
      settle(local);
      local.data.open = true;
      for (const message of local.data.waiting) remote.send(message);
      local.data.waiting = [];
      local.data.waitingBytes = 0;
    };
    // as this PC's own sockets: output that cannot be delivered, or backs up past the budget, ends the socket (4008);
    // the budget leaves room for one message as large as the PC may send (LARGE_WS_MESSAGES), a large session's snapshot
    remote.onMessage = (message) => {
      if (local.send(message) === 0 || local.getBufferedAmount() > OUTPUT_HARD_BYTES + MAX_LARGE_WS_MESSAGE_BYTES) local.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    };
    remote.onClose = (event) => { settle(local); local.close(sendableClose(event.code), event.reason.slice(0, 100)); };
  };
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const authorized = (request: Request): boolean => {
    const given = Buffer.from(request.headers.get("authorization") ?? "");
    return given.length === expected.length && timingSafeEqual(given, expected);
  };
  const sockets = new Set<Bun.ServerWebSocket<Forwarded>>();
  const server = Bun.serve<Forwarded>({
    // no idle cut of its own (Bun's default is 10 s): a slow answer from the PC is bounded by the one asking
    hostname: "127.0.0.1", port: 0, idleTimeout: 0,
    fetch(request, bun) {
      if (!authorized(request)) return new Response(null, { status: 401 });
      const url = new URL(request.url);
      const target = url.pathname + url.search;
      if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        return bun.upgrade(request, { data: { target, open: false, pending: true, waiting: [], waitingBytes: 0, closed: false, abort: new AbortController() } }) ? undefined : new Response(null, { status: 400 });
      }
      return forward(request, target).catch(() => new Response(null, { status: 502 }));
    },
    websocket: {
      open(local) {
        sockets.add(local);
        busy++;
        void connect(local);
      },
      message(local, message) {
        sentAt = performance.now();
        const data = typeof message === "string" ? message : new Uint8Array(message);
        if (local.data.open) { local.data.remote?.send(data); return; }
        local.data.waitingBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (local.data.waitingBytes > WAITING_BYTES) { local.close(1009, "too much sent before the PC answered"); return; }
        local.data.waiting.push(data);
      },
      close(local, code, reason) {
        sockets.delete(local);
        settle(local);
        local.data.closed = true;
        local.data.waiting = [];
        local.data.abort.abort();
        local.data.remote?.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 100));
      },
    },
  });

  // Coming back to an earlier route. One check at a time; a network change while one runs asks for another after it.
  let checking = false;
  let recheck = false;
  /** a move that came back unusable (a carrier that answers a probe but cannot carry a session) waits longer next time */
  let nextCheck: ReturnType<typeof setTimeout> | undefined;
  /** The routes before the one carrying the channel now: every direct carrier while on the relay. */
  const earlier = (): string[] => {
    const order = routes();
    const at = current?.direct === undefined ? -1 : order.indexOf(current.direct);
    return at < 0 ? (current?.direct === undefined ? order : []) : order.slice(0, at);
  };
  const quiet = (): boolean => busy === 0 && performance.now() - sentAt >= QUIET_MS;
  const later = (ms: number): void => {
    clearTimeout(nextCheck);
    nextCheck = setTimeout(() => { nextCheck = undefined; check(); }, ms);
    nextCheck.unref?.();
  };
  const pause = (ms: number): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); ending.signal.removeEventListener("abort", done); resolve(); }
    ending.signal.addEventListener("abort", done, { once: true });
  });
  /**
   * Signs in on `direct` while new streams wait, then makes it the current session and closes `from`: "moved". "busy"
   * when something started on `from` meanwhile (input on an open socket, a request let through before): the new
   * session is dropped and the move waits. "failed" when it could not sign in there (a refusal there is one the
   * current session meets too, and says so). The old session ending meanwhile (the PC let the new one in in its
   * place) is no loss when the new one is up, and the connection's loss when not.
   */
  const move = async (direct: string, from: RelayChannel): Promise<"moved" | "busy" | "failed"> => {
    const startedAt = performance.now();
    const settled = Promise.withResolvers<void>();
    moving = settled.promise;
    replaced = undefined;
    let next: RelayChannel | undefined;
    try { next = await openOn(direct, DIRECT_BUDGET_MS * 4); } catch { next = undefined; }
    const gone = replaced;
    moving = undefined;
    replaced = undefined;
    try {
      if (closed || current !== from || !next?.mux.active) {
        next?.close();
        if (gone && !closed && current === from) lost(gone);
        return "failed";
      }
      // only streams waiting for this move may be under way, and no input since it began; else the old session stays
      if (!gone && (busy > waitingForMove || sentAt >= startedAt)) { next.close(); return "busy"; }
      install(next);
      Object.assign(probes, { backoff: 1, failed: false });
      options.onMoved?.();
      from.close();
      return "moved";
    } finally {
      settled.resolve();
    }
  };
  const check = (): void => {
    if (closed || checking) return;
    const candidates = earlier();
    if (candidates.length === 0) return;
    const wait = probes.at + PROBE_EVERY_MS * probes.backoff - performance.now();
    if (wait > 0) { if (nextCheck === undefined) later(wait); return; }
    checking = true;
    recheck = false;
    tried(probes);
    clearTimeout(nextCheck); nextCheck = undefined;
    const from = current;
    const still = (): boolean => !closed && current === from;
    void (async () => {
      /** a carrier that proved to be the PC but could not carry a session: the next check waits longer */
      let unusable = false;
      /** some carrier proved to be the PC */
      let answered = false;
      for (const direct of candidates) {
        if (!still()) return;
        if (!await probeDirect(signIn, direct, directSocket, DIRECT_BUDGET_MS, ending.signal)) continue;
        answered = true;
        let outcome: "moved" | "busy" | "failed" = "busy";
        for (let round = 0; round < IDLE_CHECKS && still() && outcome === "busy"; round++) {
          // input a moment ago: only until it has been quiet long enough; a request under way: a while
          if (!quiet()) { await pause(busy > 0 ? IDLE_CHECK_MS : Math.max(1, QUIET_MS - (performance.now() - sentAt))); continue; }
          outcome = await move(direct, from!);
        }
        if (outcome === "failed") unusable = true;
        if (outcome === "moved" || !still()) return;
      }
      // from the relay, and no carrier answered at all: a sign-in skips them until the next check is due. Not when a
      // later direct route carries the channel (it works), nor when one answered but the move had to wait.
      // a check whose tunnel closed or moved meanwhile proves nothing (its probe was cut off): the state is not its to set
      if (!still()) return;
      if (from?.direct === undefined && !answered) probes.failed = true;
      // a carrier that proved to be the PC is one a sign-in tries, whatever an earlier try found
      if (answered) probes.failed = false;
      if (unusable) probes.backoff = Math.min(probes.backoff * 2, 12);
    })().catch(() => { /* a probe that fails is a route that is not there: the current one stays */ }).finally(() => {
      checking = false;
      if (closed) return;
      if (recheck || current !== from) { recheck = false; if (current === from) probes.at = -Infinity; check(); return; }
      later(PROBE_EVERY_MS * probes.backoff);
    });
  };
  let network = startNetwork;
  // the wall clock: the monotonic one may stand still while the PC sleeps, which would hide the wake
  let lastLook = Date.now();
  const watcher = setInterval(() => {
    const now = Date.now();
    const seen = readNetwork();
    // a timer far later than asked is a PC that slept: it may wake on another network, even one with the same addresses
    if (seen === network && now - lastLook < networkCheckMs * 2) { lastLook = now; return; }
    network = seen;
    lastLook = now;
    Object.assign(probes, newRouteProbes(), { network: seen });
    if (checking) recheck = true; else check();
  }, networkCheckMs);
  watcher.unref?.();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(watcher);
    clearTimeout(nextCheck);
    ending.abort();
    for (const socket of sockets) socket.close(1012, "PC connection lost");
    for (const wake of [...waiting]) wake();
    void server.stop(true);
    current?.close();
  };
  lost = (error) => {
    if (closed) return;
    close();
    options.onLost(fatal(error) ? new RelayPcRefused(refusal(error, false), { cause: error }) : new Error("Relay connection to this PC was lost", { cause: error }));
  };
  // a channel that ended between its admission and here: the caller's failed attempt, not a loss it is told of
  if (!current.mux.active) { close(); throw new Error("Relay carrier lost during admission"); }
  check();
  return {
    endpoint: { url: `http://127.0.0.1:${server.port}`, token },
    get route() { return current?.direct === undefined ? "relay" : "direct"; },
    close,
  };
}

/** A comparison that asks to pair this PC with another PC of the account, and only with one that selects that. */
function vouchedPairing(pairing: { compare: (digits: string) => Promise<void>; signal: AbortSignal }): Partial<RelayChannelOptions> {
  return {
    compare: pairing.compare, signal: pairing.signal, intent: "vouched",
    beforeRequest: (server) => { if (!server.features?.includes(PAIR_INTENT_VOUCHED)) throw new RelayPcOutdated(); },
  };
}

/** What another PC of the account answers when asked to pair with this one: nothing is sent to pair, and nothing counted there. */
export type VouchedSupport = "ready" | "outdated" | "offline";

/**
 * Whether `offer`'s PC would take a pairing from this one through the account (PAIR_INTENT_VOUCHED): the channel is
 * opened, the PC's answer to HELLO read, and the channel closed before PAIR_REQUEST, with a key that is never kept.
 */
export async function vouchedSupport(offer: RelayOffer, options: { socket?: (url: string) => RelaySocket; pcAnswerMs?: number } = {}): Promise<VouchedSupport> {
  const { code: _code, ...plain } = offer;
  class Answered extends Error { constructor(readonly ready: boolean) { super("answered"); } }
  try {
    const key = await RelayPcKey.create("", plain, () => false);
    await openRelayChannelWithFallback(plain, {
      store: key, label: relayPcLabel(), compare: () => new Promise<void>(() => {}), intent: "vouched",
      beforeRequest: (server) => { throw new Answered(server.features?.includes(PAIR_INTENT_VOUCHED) === true); },
      ...(options.socket ? { socket: options.socket } : {}), ...(options.pcAnswerMs === undefined ? {} : { pcAnswerMs: options.pcAnswerMs }),
    }, openRelayChannel);
    return "ready";
  } catch (error) {
    if (error instanceof Answered) return error.ready ? "ready" : "outdated";
    // a PC of another relay generation, or one that cannot pair without a code
    if (error instanceof MuxProtocolError && (error.code === "unsupported_version" || error.code === "unsupported_extension")) return "outdated";
    return "offline";
  }
}

function refusal(error: Error, pairing: boolean): string {
  const code = "code" in error ? error.code : undefined;
  // a saved key the PC no longer knows was revoked there, perhaps while this PC was away
  if (code === "auth_revoked" || code === "auth_failed" && !pairing) return "That PC removed this PC's access. Add it again with a new pairing link.";
  if (code === "auth_failed") return "That PC did not accept this PC. The pairing link may be used or expired; copy a new one.";
  if (code === "server_identity_changed") return "That PC has a new relay identity. Add it again with a new pairing link.";
  if (code === "unsupported_version" || code === "unsupported_extension" || code === "unsupported_transport") return "That PC runs a version of Ovis this app cannot talk to. Update both PCs.";
  return error.message;
}
