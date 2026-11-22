/**
 * The relay's channel without the relay (docs/relay.md, "Direct on the same network"): a plain
 * WebSocket listener on this PC's private IPv4 addresses, and on its Tailscale one for a phone that
 * can open that (DIRECT_TAILNET), that a phone, told them in AUTH_OK
 * (DIRECT_CARRIER), opens instead of relay.ovis.sh. It speaks what the relay speaks to a client
 * (`/v1/ws`, an `assigned` frame, then the client's Noise records) and hands the socket to the same
 * RelaySession a relay data socket gets. No TLS: Noise against the PC key the phone pinned at pairing
 * proves this PC and protects the records, so an address is only ever a hint where to try.
 *
 * Narrower than the relay: devices sign in here, nothing pairs (RelaySession signInOnly). Clients
 * that have not signed in are bounded per source address and in total, apart from the relay's, so
 * nobody on the network can crowd out relay service; signed-in sessions keep the relay's limits.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { TCPSocketListener } from "bun";
import { GATE_HEADER, openGate, PEER_HEADER } from "./direct-gate.ts";
import { createSocket } from "node:dgram";
import { networkInterfaces } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { importPublicKey, importSecretKey, MAX_CARRIER_TEXT_BYTES, openDaemonSecureChannel } from "../../shared/relay-e2ee.ts";
import type { Transport } from "../../shared/relay-e2ee.ts";
import type { MuxClock } from "../../shared/relay-mux-engine.ts";
import { isDirectCarrier, isTailnetCarrier, MAX_DIRECT_CARRIERS } from "../../shared/relay-mux.ts";
import { inTailnet } from "../access.ts";
import type { RequestServices } from "../dispatch.ts";
import { privateLanPeer } from "../lan-https.ts";
import { SignedInSessions } from "./admissions.ts";
import type { RelayIdentity } from "./identity.ts";
import { RelaySession, relayClock } from "./session.ts";
import type { RelaySocketHandlers } from "./virtual-socket.ts";
import { version } from "../../package.json";

export const DIRECT_PORT = 7319;
/** Carriers not yet signed in: per source address, and in total across every address listened on. */
const MAX_PENDING_PER_SOURCE = 2;
const MAX_PENDING = 64;
/** From upgrade to an open protected channel, and from there to a signed-in device. */
const HANDSHAKE_MS = 5_000;
const SIGN_IN_MS = 15_000;
/** How long a client that has not signed in keeps its place against newer ones. */
const GRACE_MS = 1_000;
const REFRESH_MS = 30_000;

/** Adapters a phone on the PC's network is not on: containers, VMs, VPNs and tunnels. */
const VIRTUAL_INTERFACE = /^(docker|br-|virbr|veth|vmnet|vboxnet|vnic|utun|tun|tap|tailscale|zt|wg|lxc|lxd|podman|cni|flannel|cali|vethernet|vmware|virtualbox|hyper-v|wsl|bridge)/i;

/**
 * The private IPv4 addresses to listen on and name, at most MAX_DIRECT_CARRIERS: the one the PC's
 * default route leaves from first, then the others in the system's order, leaving out virtual
 * adapters (unless the route leaves from one).
 */
export function rankLanAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, routed: string | null): string[] {
  const found = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && privateLanPeer(entry.address))
    .map((entry) => ({ name, address: entry.address })));
  const real = found.filter((entry) => entry.address === routed || !VIRTUAL_INTERFACE.test(entry.name)).map((entry) => entry.address);
  const ordered = routed !== null && real.includes(routed) ? [routed, ...real] : real;
  return [...new Set(ordered)].slice(0, MAX_DIRECT_CARRIERS);
}

/** The address the default route leaves from: a UDP socket "connected" to a public address, which sends nothing. */
function routedAddress(): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = createSocket("udp4");
    const done = (address: string | null): void => { try { socket.close(); } catch {} resolve(address); };
    socket.once("error", () => done(null));
    socket.connect(9, "1.1.1.1", () => {
      try { done(socket.address().address); } catch { done(null); }
    });
  });
}

/** Tailscale's own adapter by name: tailscale0 on Linux, "Tailscale" on Windows. */
const TAILSCALE_INTERFACE = /^tailscale/i;
/** macOS gives Tailscale a utun, as it does every other VPN: one counts only with the address tailscale names. */
const TUNNEL_INTERFACE = /^utun\d*$/i;

/** A Tailscale IPv4 address (100.64.0.0/10), in any spelling a socket gives it. */
export function tailnetPeer(address: string | null | undefined): boolean {
  const plain = address?.startsWith("::ffff:") ? address.slice("::ffff:".length) : address ?? "";
  return /^\d+\.\d+\.\d+\.\d+$/.test(plain) && inTailnet(plain);
}

/**
 * This PC's Tailscale IPv4 address to listen on: an address in Tailscale's range on Tailscale's own adapter,
 * or on a macOS utun only when it is the one `tailscale status` names (`named`); with a named address on an
 * adapter, only that one. Never one on a real adapter (an ISP's shared address space) or another VPN's tunnel, whatever a
 * stale status says. At most one.
 */
export function tailnetAddresses(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>, named: string | null): string[] {
  // an address the status named that is on no adapter is stale (Tailscale moved it): Tailscale's own adapter still counts
  const known = Object.values(interfaces).some((list) => list?.some((entry) => entry.address === named)) ? named : null;
  const found = Object.entries(interfaces).flatMap(([name, list]) => (list ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && tailnetPeer(entry.address)
      && (known === null || entry.address === known)
      && (TAILSCALE_INTERFACE.test(name) || (TUNNEL_INTERFACE.test(name) && entry.address === known)))
    .map((entry) => entry.address));
  return found.slice(0, 1);
}

/** Who may connect to a listener on `listening`: a Tailscale peer on the Tailscale address, a private one elsewhere. */
export function directPeerAllowed(listening: string, source: string | undefined): boolean {
  return tailnetPeer(listening) ? tailnetPeer(source) : privateLanPeer(source);
}

export interface DirectCarrierOptions {
  readonly identity: RelayIdentity;
  readonly services: RequestServices;
  readonly port: number;
  readonly serverVersion?: string;
  readonly clock?: MuxClock;
  /** The private addresses to listen on; this PC's own by default (rankLanAddresses). Tests name loopback. */
  readonly addresses?: () => readonly string[];
  readonly sessions?: SignedInSessions;
  readonly preferredPort?: number;
  /** Whether a peer may connect; private IPv4 only by default. Tests on loopback widen it. */
  readonly peerAllowed?: (address: string | undefined) => boolean;
  readonly refreshMs?: number;
  readonly advertise?: (port: number) => readonly string[];
  /** This PC's Tailscale address as `tailscale status` says it (tailnetAddresses), or null when unknown. */
  readonly tailnetIp?: () => string | null;
  readonly tailnetAddresses?: () => readonly string[];
}

interface SocketData {
  readonly source: string;
  readonly id: string;
}

interface Carrier {
  readonly socket: Bun.ServerWebSocket<SocketData>;
  readonly source: string;
  readonly transport: Transport;
  readonly sockets: Set<Parameters<RelaySocketHandlers["open"]>[0]>;
  cancelTimeout: () => void;
  readonly order: number;
  /** when it opened, on the carrier's clock: a client gets GRACE_MS before a newer one may take its place */
  readonly openedAt: number;
  session?: RelaySession;
  deviceId?: string;
  release?: () => void;
  chosen?: () => void;
}

/**
 * Who gives way so one more client from `source` can wait to sign in (DirectCarrier.makeRoom), or null when
 * nobody may. Each address has MAX_PENDING_PER_SOURCE places that only its own clients take, its oldest
 * giving way past GRACE_MS; MAX_PENDING across all addresses is far above what a few hosts can hold, so a
 * phone at any address of its own gets in unless dozens of hosts on the network flood together, and then
 * it stays on the relay.
 */
export function admissionDrops<T extends { readonly source: string; readonly openedAt: number; readonly order: number }>(
  waiting: readonly T[], source: string, now: number): T[] | null {
  const pending = [...waiting].sort((a, b) => a.order - b.order);
  const old = (carrier: T): boolean => now - carrier.openedAt >= GRACE_MS;
  const drops: T[] = [];
  const own = pending.filter((carrier) => carrier.source === source);
  if (own.length >= MAX_PENDING_PER_SOURCE) {
    const oldest = own.find(old);
    if (!oldest) return null;
    drops.push(oldest);
  }
  const others = pending.filter((carrier) => !drops.includes(carrier));
  if (others.length >= MAX_PENDING) {
    const counts = new Map<string, number>();
    for (const carrier of others) counts.set(carrier.source, (counts.get(carrier.source) ?? 0) + 1);
    const oldest = others.filter(old).sort((a, b) => (counts.get(b.source)! - counts.get(a.source)!) || a.order - b.order)[0];
    if (!oldest) return null;
    drops.push(oldest);
  }
  return drops;
}

export class DirectCarrier {
  private listeners: TCPSocketListener<unknown>[] = [];
  /** the carrier's HTTP server on loopback, behind the gates (direct-gate.ts) */
  private upstream: Bun.Server<SocketData> | undefined;
  private readonly secret = randomBytes(32).toString("hex");
  /** connections per address, shared by every gate */
  private readonly connections = new Map<string, number>();
  private bound: { addresses: readonly string[]; port: number } | null = null;
  private readonly carriers = new Map<string, Carrier>();
  private stopped = false;
  private opened = 0;
  private cancelRefresh: (() => void) | undefined;
  private readonly clock: MuxClock;
  private readonly signedIn: SignedInSessions;

  constructor(private readonly options: DirectCarrierOptions) {
    this.clock = options.clock ?? relayClock;
    this.signedIn = options.sessions ?? new SignedInSessions();
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    await this.refresh();
    const again = (): void => {
      if (this.stopped) return;
      void this.refresh().finally(() => { if (!this.stopped) this.cancelRefresh = this.clock.setTimeout(again, this.options.refreshMs ?? REFRESH_MS); });
    };
    if (!this.stopped) this.cancelRefresh = this.clock.setTimeout(again, this.options.refreshMs ?? REFRESH_MS);
  }

  private async refresh(): Promise<void> {
    const tailnet = this.options.tailnetAddresses?.()
      ?? (this.options.addresses ? [] : tailnetAddresses(networkInterfaces(), this.options.tailnetIp?.() ?? null));
    const lan = this.options.addresses?.() ?? rankLanAddresses(networkInterfaces(), await routedAddress());
    if (!this.stopped) this.bind([...lan.slice(0, MAX_DIRECT_CARRIERS - Math.min(tailnet.length, 1)), ...tailnet.slice(0, 1)]);
  }

  /**
   * What AUTH_OK tells a phone: `ws://<address>:<port>` for each address listened on, at most
   * MAX_DIRECT_CARRIERS, the Tailscale one only with `tailnet` (the phone offered DIRECT_TAILNET).
   */
  advertised(tailnet: boolean): readonly string[] {
    if (!this.bound) return [];
    const { addresses, port } = this.bound;
    const named = this.options.advertise?.(port) ?? addresses.map((address) => `ws://${address}:${port}`);
    return named.filter((carrier) => isDirectCarrier(carrier) && (tailnet || !isTailnetCarrier(carrier))).slice(0, MAX_DIRECT_CARRIERS);
  }

  get port(): number | null { return this.bound?.port ?? null; }

  get sessions(): number { return [...this.carriers.values()].filter((carrier) => carrier.deviceId && carrier.session?.mux.active).length; }

  private bind(listed: readonly string[]): void {
    const addresses = [...new Set(listed)];
    if (this.bound && addresses.join() === this.bound.addresses.join()) return;
    const previous = this.listeners;
    // the port in use is kept across a change, so phones told it a moment ago still find this PC
    const wanted = this.bound?.port ?? this.options.preferredPort ?? DIRECT_PORT;
    this.listeners = [];
    this.bound = null;
    // released before the new ones bind: an address that stayed may hold the port
    for (const listener of previous) listener.stop(false);
    if (addresses.length === 0) return;
    for (const port of wanted === 0 ? [0] : [wanted, 0]) {
      const made: TCPSocketListener<unknown>[] = [];
      try {
        let chosen = port;
        for (const address of addresses) {
          const listener = this.listen(address, chosen);
          made.push(listener);
          chosen = listener.port ?? chosen;
        }
        this.listeners = made;
        this.bound = { addresses, port: chosen };
        return;
      } catch (error) {
        for (const listener of made) listener.stop(true);
        if (port === 0) console.error(`Direct connections on this network are off: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** A gate on `address` in front of the loopback server (made at the first one). */
  private listen(address: string, port: number): TCPSocketListener<unknown> {
    this.upstream ??= this.serveUpstream();
    return openGate({ hostname: address, port, upstreamPort: this.upstream.port!, secret: this.secret,
      allowed: (source) => this.options.peerAllowed ? this.options.peerAllowed(source) : directPeerAllowed(address, source), counts: this.connections }) as TCPSocketListener<unknown>;
  }

  /** The carrier's HTTP server: on loopback, answering only what a gate of this carrier forwarded. */
  private serveUpstream(): Bun.Server<SocketData> {
    return Bun.serve<SocketData>({
      hostname: "127.0.0.1", port: 0,
      idleTimeout: 10,
      fetch: (request, server) => {
        const loopback = server.requestIP(request)?.address;
        const given = Buffer.from(request.headers.get(GATE_HEADER) ?? "");
        const expected = Buffer.from(this.secret);
        const vouched = given.length === expected.length && timingSafeEqual(given, expected) && (loopback === "127.0.0.1" || loopback === "::ffff:127.0.0.1");
        const source = vouched ? request.headers.get(PEER_HEADER) ?? undefined : undefined;
        // each gate let through only its own network's peers (directPeerAllowed); this checks again for either
        if (!vouched || !(this.options.peerAllowed ?? ((peer) => privateLanPeer(peer) || tailnetPeer(peer)))(source) || source === undefined) return new Response(null, { status: 403 });
        if (new URL(request.url).pathname !== "/v1/ws") return new Response(null, { status: 404 });
        // a browser page always names its origin; the apps' sockets name none. No web page on the network opens this.
        if (request.headers.has("origin")) return new Response(null, { status: 403 });
        if (this.stopped) return new Response(null, { status: 503 });
        // only a WebSocket upgrade may take a place: any other request changes nothing here
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket" || !request.headers.has("sec-websocket-key")) return new Response(null, { status: 426 });
        // asked only: nobody gives way until the upgrade has happened (open)
        if (!this.makeRoom(source, false)) return new Response(null, { status: 503 });
        return server.upgrade(request, { data: { source, id: randomBytes(16).toString("hex") } })
          ? undefined : new Response(null, { status: 426 });
      },
      websocket: {
        // Bun's own pings find a phone that left without closing
        idleTimeout: 60, sendPings: true,
        // one protected mux frame is the largest message there is (relay-e2ee.ts); Bun refuses more before buffering it
        maxPayloadLength: MAX_CARRIER_TEXT_BYTES,
        open: (socket) => this.open(socket),
        message: (socket, message) => this.message(socket, message),
        close: (socket, code, reason) => this.closed(socket, code, reason),
      },
    });
  }

  private makeRoom(source: string, apply: boolean): boolean {
    const pending = [...this.carriers.values()].filter((carrier) => !carrier.deviceId);
    const drops = admissionDrops(pending, source, this.clock.now());
    if (drops === null) return false;
    if (apply) for (const carrier of drops) this.drop(carrier);
    return true;
  }

  private drop(carrier: Carrier): void {
    const id = carrier.socket.data.id;
    if (this.carriers.get(id) !== carrier) return;
    carrier.cancelTimeout();
    this.carriers.delete(id);
    carrier.session?.close("resource_exhausted");
    carrier.transport.onclose?.(1013, "Try again");
    carrier.socket.close(1013, "Try again");
  }

  private open(socket: Bun.ServerWebSocket<SocketData>): void {
    const { id, source } = socket.data;
    if (this.stopped) { socket.close(1001, "Direct connections stopped"); return; }
    // the upgrade happened: now someone may give way (or, if the places filled meanwhile, this one goes)
    if (!this.makeRoom(source, true)) { socket.close(1013, "Try again"); return; }
    const transport: Transport = {
      onmessage: null, onclose: null, onerror: null,
      // a record Bun dropped (0) would break the protected stream after it: the carrier ends instead
      send: (data) => { if (socket.send(data) === 0) socket.close(1011, "Send dropped"); },
      close: (code, reason) => socket.close(code, reason),
    };
    const carrier: Carrier = { socket, source, transport, order: ++this.opened, openedAt: this.clock.now(), sockets: new Set(), cancelTimeout: this.clock.setTimeout(() => socket.close(), HANDSHAKE_MS) };
    this.carriers.set(id, carrier);
    socket.send(JSON.stringify({ type: "assigned", connection_id: id }));
    const { identity, services } = this.options;
    void openDaemonSecureChannel(transport, {
      daemonKeyPair: { publicKey: importPublicKey(identity.public_key), secretKey: importSecretKey(identity.secret_key) },
      events: { onmessage: (data) => { if (!this.stopped) carrier.session?.receive(data); } },
    }).then((channel) => {
      if (this.stopped || this.carriers.get(id) !== carrier || !channel.isOpen()) { channel.close(); return; }
      carrier.cancelTimeout();
      carrier.cancelTimeout = this.clock.setTimeout(() => {
        if (carrier.session?.verifying) carrier.cancelTimeout = this.clock.setTimeout(() => socket.close(), 5_000);
        else socket.close();
      }, SIGN_IN_MS);
      const handlers = services.core.socketHandlers;
      carrier.session = new RelaySession({
        channel, services, port: this.options.port, serverId: identity.server_id,
        serverVersion: this.options.serverVersion ?? version, minSupportedClient: "0.4.20",
        routingOverhead: 0, maxWireMessageBytes: 64 * 1024, signInOnly: true,
        directCarriers: (tailnet) => this.advertised(tailnet),
        onAuthenticated: (deviceId) => this.authenticated(id, carrier, deviceId),
        onChosen: () => carrier.chosen?.(),
        websocket: {
          ...handlers,
          open: (peer) => { carrier.sockets.add(peer); return handlers.open(peer); },
          close: (peer, code, reason) => { carrier.sockets.delete(peer); handlers.close(peer, code, reason); },
        },
      });
    }).catch(() => socket.close());
  }

  private message(socket: Bun.ServerWebSocket<SocketData>, message: string | Buffer): void {
    const carrier = this.carriers.get(socket.data.id);
    if (!carrier) { socket.close(); return; }
    const data = typeof message === "string" ? message : message.buffer.slice(message.byteOffset, message.byteOffset + message.byteLength) as ArrayBuffer;
    carrier.transport.onmessage?.({ data, isBinary: typeof message !== "string" });
  }

  private closed(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
    const carrier = this.carriers.get(socket.data.id);
    if (!carrier) return;
    carrier.cancelTimeout();
    carrier.release?.();
    this.carriers.delete(socket.data.id);
    carrier.transport.onclose?.(code, reason);
  }

  private authenticated(id: string, carrier: Carrier, deviceId: string): void {
    if (this.carriers.get(id) !== carrier) return;
    carrier.cancelTimeout();
    carrier.deviceId = deviceId;
    const line = carrier.session ? { route: inTailnet(carrier.source) ? "tailscale" as const : "lan" as const, since: Date.now(), mux: carrier.session.mux } : undefined;
    const admission = this.signedIn.candidate(deviceId, () => carrier.session?.close("resource_exhausted"), line);
    carrier.release = admission.release;
    carrier.chosen = admission.chosen;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelRefresh?.();
    const listeners = this.listeners.splice(0);
    for (const listener of listeners) listener.stop(false);
    this.bound = null;
    await Promise.all([...this.carriers.values()].map(async (carrier) => {
      carrier.cancelTimeout();
      for (const socket of carrier.sockets) socket.close(1001, "Direct connections stopped");
      if (carrier.session) {
        await carrier.session.mux.flush();
        carrier.session.mux.goAway("shutdown", 0);
        await carrier.session.mux.flush();
      }
      carrier.socket.close();
      carrier.release?.();
    }));
    this.carriers.clear();
    for (const listener of listeners) listener.stop(true);
    void this.upstream?.stop(true);
    this.upstream = undefined;
  }
}
