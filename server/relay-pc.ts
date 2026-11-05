/**
 * Another PC added through the Ovis relay, with no SSH (docs/remote-pcs.md, "Through the relay"). This server pairs
 * with that PC's Ovis the way a phone does (shared/relay-channel.ts: Noise NK, Ovis Mux v1, a device key it signs
 * in with), and that PC sees it as one more paired device it can revoke. A loopback forward then gives the PC the
 * same `{ url, token }` endpoint an SSH local forward gives (machines.ts), so everything that reads a remote PC
 * through its endpoint (its roster, status socket, API routes and terminals) runs unchanged over the relay.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { openRelayChannel, UnsafeRelayDestinationError } from "../shared/relay-channel.ts";
import type { RelayChannel, RelaySocket } from "../shared/relay-channel.ts";
import { base64url, ServerIdentityChangedError } from "../shared/relay-device.ts";
import type { RelayDevice, RelayDeviceStore } from "../shared/relay-device.ts";
import { MuxStreamError } from "../shared/relay-mux-engine.ts";
import type { HttpRequest, WsStream } from "../shared/relay-mux-engine.ts";
import { MuxProtocolError, REQUEST_HEADERS } from "../shared/relay-mux.ts";
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

export function relayPcLabel(): string { return `Ovis on ${hostname()}`.slice(0, 64); }

interface SavedKey {
  v: 1;
  offer: RelayOffer;
  device_id: string;
  label: string;
  public_spki: string;
  /** P-256 private key, PKCS#8, base64url: this server's only secret for that PC */
  private_pkcs8: string;
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
    return new RelayPcKey(path, {
      server_id: offer.server_id, server_public_key: offer.server_public_key, relay: offer.relay,
      ...(offer.name === undefined ? {} : { name: offer.name }),
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

  async get(serverId: string): Promise<RelayDevice | undefined> {
    return serverId === this.device.server_id ? this.device : undefined;
  }

  async update(serverId: string, change: (current: RelayDevice | undefined) => RelayDevice): Promise<RelayDevice> {
    if (serverId !== this.device.server_id) throw new Error("Relay PC key names another PC");
    // the current one is handed over only once admitted: a new key is a pairing that channel.ts saves on AUTH_OK
    const next = change(this.device.device_id === null ? undefined : this.device);
    if (next.device_id === null) throw new Error("Relay PC was not admitted");
    if (!this.wanted()) throw new Error("Relay PC was removed");
    writePrivateState(this.path, {
      v: 1, offer: this.offer, device_id: next.device_id, label: next.label, public_spki: next.public_spki, private_pkcs8: this.pkcs8,
    } satisfies SavedKey);
    this.device = next;
    return next;
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

interface Forwarded { target: string; remote?: WsStream; open: boolean; waiting: (string | Uint8Array)[]; waitingBytes: number; closed: boolean; abort: AbortController }

/** What a socket may send before the other PC accepted its stream; past it the socket closes (1009). */
const WAITING_BYTES = 1024 * 1024;

/** A close code a server-side socket may send: the relay's own (1006) and reserved ones become 1011. */
function sendableClose(code: number): number {
  return code === 1000 || code === 1001 || code === 1008 || code === 1011 || code === 1012 || (code >= 3000 && code <= 4999) ? code : 1011;
}

/**
 * Connects to the PC (pairing with the offer's code the first time, signing in with the saved key after), then
 * serves it on 127.0.0.1 behind a random token: each request and WebSocket becomes a stream of the one mux session.
 * `onLost` fires once when the connection ends; the caller decides whether to try again (a RelayPcRefused never
 * should). Never retries by itself.
 */
export async function openRelayPcTunnel(offer: RelayOffer, key: RelayPcKey, options: {
  socket?: (url: string) => RelaySocket;
  onLost: (error: Error) => void;
}): Promise<RelayPcTunnel> {
  let closed = false;
  let lost = (error: Error): void => { void error; };
  let channel: RelayChannel;
  try {
    channel = await openRelayChannel(offer, {
      store: key, label: (await key.list())[0]!.label, socket: options.socket,
      // whoever asks through the forward sets the deadline (the machine proxy: 75 s, 165 s for its slow routes)
      requestTimeoutMs: () => 0,
      onClose: (error) => { lost(error); },
    });
  } catch (error) {
    throw fatal(error) ? new RelayPcRefused(refusal(error, offer.code !== undefined), { cause: error }) : error;
  }
  const mux = channel.mux;
  const waiting = new Set<() => void>();
  mux.onStreamAvailable = () => { for (const wake of [...waiting]) wake(); };
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
    const stream = await opened(() => mux.openHttp({
      target, method: request.method as HttpRequest["method"], body: body ? "stream" : "none",
      headers: [...request.headers].filter(([name]) => allowed.includes(name)),
    }), request.signal);
    return new Promise<Response>((resolve, reject) => {
      const aborted = (): void => { stream.reset(); reject(request.signal.reason); };
      request.signal.addEventListener("abort", aborted, { once: true });
      if (request.signal.aborted) { aborted(); return; }
      stream.onDispose = (error) => {
        request.signal.removeEventListener("abort", aborted);
        if (error) reject(error);
      };
      stream.onHeaders = ({ status, headers }) => {
        if (status >= 200) resolve(new Response(stream.noBody ? null : stream.body, { status, headers: headers.map(([name, value]) => [name, value]) }));
      };
      if (body) void stream.sendBody(body).catch(() => { if (stream.live) stream.reset("internal_error"); });
    });
  };
  const connect = async (local: Bun.ServerWebSocket<Forwarded>): Promise<void> => {
    let remote: WsStream;
    try { remote = await opened(() => mux.openWs({ target: local.data.target, headers: [], protocols: [] }), local.data.abort.signal); }
    catch { local.close(1012, "PC connection lost"); return; }
    if (local.data.closed) { remote.close(1000); return; }
    local.data.remote = remote;
    remote.onAccept = () => {
      local.data.open = true;
      for (const message of local.data.waiting) remote.send(message);
      local.data.waiting = [];
      local.data.waitingBytes = 0;
    };
    // as this PC's own sockets: output that cannot be delivered, or backs up past the budget, ends the socket (4008)
    remote.onMessage = (message) => {
      if (local.send(message) === 0 || local.getBufferedAmount() > OUTPUT_HARD_BYTES) local.close(OUTPUT_STALLED_CLOSE_CODE, "output delivery failed");
    };
    remote.onClose = (event) => { local.close(sendableClose(event.code), event.reason.slice(0, 100)); };
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
        return bun.upgrade(request, { data: { target, open: false, waiting: [], waitingBytes: 0, closed: false, abort: new AbortController() } }) ? undefined : new Response(null, { status: 400 });
      }
      return forward(request, target).catch(() => new Response(null, { status: 502 }));
    },
    websocket: {
      open(local) {
        sockets.add(local);
        void connect(local);
      },
      message(local, message) {
        const data = typeof message === "string" ? message : new Uint8Array(message);
        if (local.data.open) { local.data.remote?.send(data); return; }
        local.data.waitingBytes += typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
        if (local.data.waitingBytes > WAITING_BYTES) { local.close(1009, "too much sent before the PC answered"); return; }
        local.data.waiting.push(data);
      },
      close(local, code, reason) {
        sockets.delete(local);
        local.data.closed = true;
        local.data.waiting = [];
        local.data.abort.abort();
        local.data.remote?.close(code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason.slice(0, 100));
      },
    },
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.close(1012, "PC connection lost");
    for (const wake of [...waiting]) wake();
    void server.stop(true);
    channel.close();
  };
  lost = (error) => {
    if (closed) return;
    close();
    options.onLost(fatal(error) ? new RelayPcRefused(refusal(error, false), { cause: error }) : new Error("Relay connection to this PC was lost", { cause: error }));
  };
  return { endpoint: { url: `http://127.0.0.1:${server.port}`, token }, close };
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
