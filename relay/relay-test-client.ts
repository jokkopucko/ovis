/**
 * A WebSocket peer of the relay for tests, the QA script and the load smoke: every frame and the
 * close are queued as events to await, each with a deadline, never a fixed wait.
 */
import { bytesToHex } from "@noble/hashes/utils.js";
import nacl from "tweetnacl";
import { answerServerChallenge, deriveServerId } from "../shared/relay-server-proof.ts";

export type Received = string | Uint8Array;

export class Peer {
  private readonly queue: Received[] = [];
  private readonly waiters: ((frame: Received) => void)[] = [];
  readonly closed: Promise<{ code: number; reason: string }>;
  readonly ready: Promise<void>;

  constructor(readonly socket: WebSocket) {
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => {
      const frame = typeof event.data === "string" ? event.data : new Uint8Array(event.data as ArrayBuffer);
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.queue.push(frame);
    });
    this.closed = new Promise((resolve) => socket.addEventListener("close", (event) => resolve({ code: event.code, reason: event.reason })));
    // a refused socket opens and closes at once; either way it is ready to be looked at
    this.ready = Promise.race([new Promise<void>((resolve) => socket.addEventListener("open", () => resolve())), this.closed.then(() => undefined)]);
  }

  static async open(url: string): Promise<Peer> {
    const peer = new Peer(new WebSocket(url));
    await within(peer.ready, `open ${url}`);
    return peer;
  }

  next(what = "a frame", timeoutMs = 5000): Promise<Received> {
    const frame = this.queue.shift();
    if (frame !== undefined) return Promise.resolve(frame);
    return within(new Promise<Received>((resolve) => this.waiters.push(resolve)), what, timeoutMs);
  }

  async json(what = "a JSON frame"): Promise<Record<string, unknown>> {
    const frame = await this.next(what);
    if (typeof frame !== "string") throw new Error(`expected text for ${what}, got ${frame.byteLength} bytes`);
    return JSON.parse(frame) as Record<string, unknown>;
  }

  closeCode(what = "the close", timeoutMs = 5000): Promise<number> {
    return within(this.closed, what, timeoutMs).then((close) => close.code);
  }

  /** frames queued and not yet taken */
  get pending(): number {
    return this.queue.length;
  }
}

export function within<T>(promise: Promise<T>, what: string, timeoutMs = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), timeoutMs); }),
  ]).finally(() => clearTimeout(timer));
}

export const randomServerId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");

/** A PC as the relay knows it: its X25519 key pair and the server_id derived from the public key. */
export interface TestServer {
  serverId: string;
  /** the public key as the socket URL carries it, 64 lowercase hex digits */
  publicKey: string;
  secretKey: Uint8Array;
}

export function newServer(): TestServer {
  const keys = nacl.box.keyPair();
  return { serverId: deriveServerId(keys.publicKey), publicKey: bytesToHex(keys.publicKey), secretKey: keys.secretKey };
}

/** The answer to the relay's server_challenge `frame` with `secretKey`, or null for anything else. */
export function answerChallenge(frame: unknown, server: TestServer, connectionId: string | null, secretKey = server.secretKey): string | null {
  return answerServerChallenge(frame, secretKey, { server_id: server.serverId, role: connectionId === null ? "control" : "data", connection_id: connectionId });
}

/** URLs of a relay at `base` (ws://host:port) for one PC; its sockets offer the PC's public key */
export function relayUrls(base: string, server: TestServer) {
  const proof = `&proof=1&public_key=${server.publicKey}`;
  return {
    control: `${base}/v1/ws?server_id=${server.serverId}&role=server&v=1${proof}`,
    client: `${base}/v1/ws?server_id=${server.serverId}&role=client&v=1`,
    data: (connectionId: string) => `${base}/v1/ws?server_id=${server.serverId}&role=server&connection_id=${connectionId}&v=1${proof}`,
  };
}

/** Opens a PC socket (control, or data for `connectionId`) and answers the relay's challenge with the PC's key. */
export async function openServer(url: string, server: TestServer, connectionId: string | null = null): Promise<Peer> {
  const peer = await Peer.open(url);
  const answer = answerChallenge(await peer.next("server_challenge"), server, connectionId);
  if (!answer) throw new Error("the relay sent no server_challenge");
  peer.socket.send(answer);
  return peer;
}

/** A PC's control socket, a client, and the data socket the PC opens for it once told. */
export async function openPair(base: string, server: TestServer, control?: Peer) {
  const urls = relayUrls(base, server);
  const ownControl = control ?? await openServer(urls.control, server);
  if (!control) await ownControl.json("sync");
  const client = await Peer.open(urls.client);
  const assigned = await client.json("assigned");
  const connected = await ownControl.json("connected");
  if (connected["connection_id"] !== assigned["connection_id"]) throw new Error("control heard of another client");
  const connectionId = assigned["connection_id"] as string;
  const data = await openServer(urls.data(connectionId), server, connectionId);
  return { control: ownControl, client, data, connectionId };
}

/** The PC answers its client's handshake: its first frame reaches the client, which then holds a full slot. */
export async function establish(pair: { client: Peer; data: Peer }, frame = "handshake answer"): Promise<void> {
  pair.data.socket.send(frame);
  const got = await pair.client.next("the PC's first frame");
  if (got !== frame) throw new Error("the client heard another first frame");
}

export function equalBytes(a: Received, b: Received): boolean {
  if (typeof a === "string" || typeof b === "string") return a === b;
  return a.byteLength === b.byteLength && a.every((byte, index) => byte === b[index]);
}
