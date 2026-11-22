/**
 * The Ovis relay as a plain Bun server, over the same core as the Cloudflare Worker: for the tests
 * and for anyone running their own relay (`bun relay/bun.ts --port 8787`, behind a TLS proxy;
 * README.md). It keeps everything in memory and stores nothing.
 */
import type { ServerWebSocket } from "bun";
import { MAX_MESSAGE_BYTES, Room, admit, type Limiters, type RoomAuthorization, type SocketInfo, type SocketRequest } from "./core.ts";
import { PairRoom, PAIR_GUEST_GAP_MS, type PairInfo, type PairSocketRequest } from "./pair-room.ts";
import { memoryLimiters, relayLimits, relayLimitsFromArgs, relayPassFromArgs, type BunRelayLimits } from "./bun-limits.ts";
import { passPolicy, type PassPolicy } from "./pass.ts";

interface SocketData { request: SocketRequest | PairSocketRequest; info: SocketInfo | PairInfo | null; address: string }
type Socket = ServerWebSocket<SocketData>;

export interface BunRelayOptions {
  port?: number;
  hostname?: string;
  limiters?: Limiters;
  limits?: Partial<BunRelayLimits>;
  pairGuestGapMs?: number;
  /** which PCs get in by their relay pass (pass.ts); every PC without it */
  pass?: PassPolicy;
}

export interface BunRelay {
  readonly port: number;
  stop(): Promise<void>;
}

const SWEEP_MS = 10_000;

export function startBunRelay(options: BunRelayOptions = {}): BunRelay {
  const limits = relayLimits(options.limits);
  const limiters = options.limiters ?? memoryLimiters(limits);
  const rooms = new Map<string, { room: Room<Socket> | PairRoom<Socket>; sockets: Set<Socket>; pending: number }>();
  const pass = options.pass;
  const keyOf = (request: SocketRequest | PairSocketRequest) => "kind" in request ? `pair:${request.nameplate}` : request.server_id;
  let socketCount = 0;
  const byAddress = new Map<string, number>();
  const release = (address: string) => {
    const left = (byAddress.get(address) ?? 1) - 1;
    if (left > 0) byAddress.set(address, left);
    else byAddress.delete(address);
  };
  const roomOf = (request: SocketRequest | PairSocketRequest) => {
    const key = keyOf(request);
    let entry = rooms.get(key);
    if (!entry) {
      const sockets = new Set<Socket>();
      const common = {
        sockets: () => sockets,
        send: (socket: Socket, frame: string | ArrayBuffer | Uint8Array) => { socket.send(frame); },
        close: (socket: Socket, code: number, reason: string) => { socket.close(code, reason); },
        now: () => Date.now(),
      };
      // a room's pass authorization lives as long as the room, which a reconnecting PC opens again with its pass
      let until: RoomAuthorization | null = null;
      const room = "kind" in request
        ? new PairRoom<Socket>({ ...common, info: (socket) => socket.data.info as PairInfo | null, setInfo: (socket, info) => { socket.data.info = info; }, ...(pass ? { pass } : {}) }, options.pairGuestGapMs ?? PAIR_GUEST_GAP_MS)
        : new Room<Socket>({ ...common, info: (socket) => socket.data.info as SocketInfo | null, setInfo: (socket, info) => { socket.data.info = info; },
          ...(pass ? { pass: { policy: pass, until: () => until, setUntil: (value: RoomAuthorization) => { until = value; } } } : {}) });
      entry = { room, sockets, pending: 0 };
      rooms.set(key, entry);
    }
    return entry;
  };
  const openIn = (room: Room<Socket> | PairRoom<Socket>, socket: Socket) => {
    const request = socket.data.request;
    if (room instanceof PairRoom) { if ("kind" in request) room.open(socket, request); }
    else if (!("kind" in request)) room.open(socket, request);
  };

  const server = Bun.serve<SocketData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address ?? "";
      const admitted = await admit(request, address, limiters, pass);
      if (admitted instanceof Response) return admitted;
      // refused, never evicted: a socket already open (a signed-in phone, its PC) keeps its place
      if ((byAddress.get(address) ?? 0) >= limits.maxSocketsPerAddress) {
        return new Response("too many open connections from this address", { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
      }
      const pairing = "kind" in admitted;
      // a pairing room needs no PC's key to open, so it never takes one of the places PCs connect to
      const kindCount = [...rooms.keys()].filter((key) => key.startsWith("pair:") === pairing).length;
      if (socketCount >= limits.maxSockets || (!rooms.has(keyOf(admitted)) && kindCount >= (pairing ? limits.maxPairRooms : limits.maxRooms))) {
        return new Response("relay capacity reached", { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } });
      }
      // Reserve synchronously before upgrading: concurrent fetches cannot oversubscribe either cap.
      const entry = roomOf(admitted);
      entry.pending++;
      socketCount++;
      byAddress.set(address, (byAddress.get(address) ?? 0) + 1);
      if (bunServer.upgrade(request, { data: { request: admitted, info: null, address } })) return undefined;
      entry.pending--;
      socketCount--;
      release(address);
      if (entry.pending === 0 && entry.sockets.size === 0) rooms.delete(keyOf(admitted));
      return new Response("expected a WebSocket upgrade", { status: 426 });
    },
    websocket: {
      // the room closes a frame over MAX_MESSAGE_BYTES with 1009; Bun's own cap only cuts the
      // connection (1006), so it stays well above for frames far too big to read at all
      maxPayloadLength: 16 * MAX_MESSAGE_BYTES,
      // a peer that cannot keep up is closed rather than having frames dropped
      closeOnBackpressureLimit: true,
      // the room closes idle sockets itself (IDLE_MS), as on Cloudflare
      idleTimeout: 0,
      open(socket) {
        const entry = roomOf(socket.data.request);
        entry.pending--;
        entry.sockets.add(socket);
        openIn(entry.room, socket);
      },
      message(socket, message) {
        rooms.get(keyOf(socket.data.request))?.room.message(socket, message);
      },
      close(socket) {
        const key = keyOf(socket.data.request);
        const entry = rooms.get(key);
        if (!entry) return;
        entry.room.closed(socket);
        entry.sockets.delete(socket);
        socketCount--;
        release(socket.data.address);
        if (entry.pending === 0 && entry.sockets.size === 0) rooms.delete(key);
      },
    },
  });
  const sweep = setInterval(() => { for (const { room } of rooms.values()) room.sweep(); }, SWEEP_MS);

  return {
    port: server.port!,
    async stop() {
      clearInterval(sweep);
      await server.stop(true);
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const port = Number(option("port") ?? process.env["PORT"] ?? 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Usage: bun relay/bun.ts [--port N] [--hostname H]");
  const hostname = option("hostname") ?? "127.0.0.1";
  const relay = startBunRelay({ port, hostname, limits: relayLimitsFromArgs(args, process.env), pass: await passPolicy(relayPassFromArgs(args, process.env)) });
  console.log(`Ovis relay listening on http://${hostname}:${relay.port}`);
  const stop = () => { void relay.stop().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
