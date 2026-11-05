/**
 * The Ovis relay as a plain Bun server, over the same core as the Cloudflare Worker: for the tests
 * and for anyone running their own relay (`bun relay/bun.ts --port 8787`, behind a TLS proxy;
 * README.md). It keeps everything in memory and stores nothing.
 */
import type { ServerWebSocket } from "bun";
import { MAX_MESSAGE_BYTES, Room, admit, type Limiters, type SocketInfo, type SocketRequest } from "./core.ts";
import { memoryLimiters, relayLimits, relayLimitsFromArgs, type BunRelayLimits } from "./bun-limits.ts";

interface SocketData { request: SocketRequest; info: SocketInfo | null; address: string }
type Socket = ServerWebSocket<SocketData>;

export interface BunRelayOptions {
  port?: number;
  hostname?: string;
  /** Overrides only rate limiting, not the hard room/socket caps. */
  limiters?: Limiters;
  limits?: Partial<BunRelayLimits>;
}

export interface BunRelay {
  readonly port: number;
  stop(): Promise<void>;
}

/** how often idle sockets are looked for */
const SWEEP_MS = 10_000;

export function startBunRelay(options: BunRelayOptions = {}): BunRelay {
  const limits = relayLimits(options.limits);
  const limiters = options.limiters ?? memoryLimiters(limits);
  const rooms = new Map<string, { room: Room<Socket>; sockets: Set<Socket>; pending: number }>();
  let socketCount = 0;
  /** open and upgrading sockets per connecting address; an address with none is forgotten */
  const byAddress = new Map<string, number>();
  const release = (address: string) => {
    const left = (byAddress.get(address) ?? 1) - 1;
    if (left > 0) byAddress.set(address, left);
    else byAddress.delete(address);
  };
  const roomOf = (serverId: string) => {
    let entry = rooms.get(serverId);
    if (!entry) {
      const sockets = new Set<Socket>();
      const room = new Room<Socket>({
        sockets: () => sockets,
        info: (socket) => socket.data.info,
        setInfo: (socket, info) => { socket.data.info = info; },
        send: (socket, frame) => { socket.send(frame); },
        close: (socket, code, reason) => { socket.close(code, reason); },
        now: () => Date.now(),
      });
      entry = { room, sockets, pending: 0 };
      rooms.set(serverId, entry);
    }
    return entry;
  };

  const server = Bun.serve<SocketData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request, bunServer) {
      const address = bunServer.requestIP(request)?.address ?? "";
      const admitted = await admit(request, address, limiters);
      if (admitted instanceof Response) return admitted;
      // refused, never evicted: a socket already open (a signed-in phone, its PC) keeps its place
      if ((byAddress.get(address) ?? 0) >= limits.maxSocketsPerAddress) {
        return new Response("too many open connections from this address", { status: 429, headers: { "retry-after": "60", "cache-control": "no-store" } });
      }
      if (socketCount >= limits.maxSockets || (!rooms.has(admitted.server_id) && rooms.size >= limits.maxRooms)) {
        return new Response("relay capacity reached", { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } });
      }
      // Reserve synchronously before upgrading: concurrent fetches cannot oversubscribe either cap.
      const entry = roomOf(admitted.server_id);
      entry.pending++;
      socketCount++;
      byAddress.set(address, (byAddress.get(address) ?? 0) + 1);
      if (bunServer.upgrade(request, { data: { request: admitted, info: null, address } })) return undefined;
      entry.pending--;
      socketCount--;
      release(address);
      if (entry.pending === 0 && entry.sockets.size === 0) rooms.delete(admitted.server_id);
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
        const entry = roomOf(socket.data.request.server_id);
        entry.pending--;
        entry.sockets.add(socket);
        entry.room.open(socket, socket.data.request);
      },
      message(socket, message) {
        rooms.get(socket.data.request.server_id)?.room.message(socket, message);
      },
      close(socket) {
        const serverId = socket.data.request.server_id;
        const entry = rooms.get(serverId);
        if (!entry) return;
        entry.room.closed(socket);
        entry.sockets.delete(socket);
        socketCount--;
        release(socket.data.address);
        if (entry.pending === 0 && entry.sockets.size === 0) rooms.delete(serverId);
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
  const relay = startBunRelay({ port, hostname, limits: relayLimitsFromArgs(args, process.env) });
  console.log(`Ovis relay listening on http://${hostname}:${relay.port}`);
  const stop = () => { void relay.stop().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
