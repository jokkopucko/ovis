/**
 * The door in front of the direct carrier (direct.ts): a plain TCP listener on a network address that
 * counts connections per peer and in all before a byte is parsed, gives the request head DEADLINE_MS
 * and HEAD_BYTES at most, answers anything but a WebSocket upgrade of `/v1/ws` from a non-browser itself,
 * and hands an upgrade to the carrier's own HTTP server on loopback, naming the peer in a header only
 * this process can vouch for. Nothing on the network reaches Bun's HTTP parser without passing here.
 */
import type { Socket, TCPSocketListener } from "bun";

/** Connections from one address, and from all, at once; past either a new one is closed unread. */
export const MAX_CONNECTIONS_PER_SOURCE = 8;
export const MAX_CONNECTIONS = 128;
/** From connect to a complete request head, whatever arrives meanwhile. */
export const DEADLINE_MS = 5_000;
/** A request head larger than this is refused. */
export const HEAD_BYTES = 8 * 1024;
/** Past this much waiting for a slow side, the other side is read no more until it drains below LOW_BYTES (TCP backpressure). */
const HIGH_BYTES = 1 << 20;
const LOW_BYTES = 256 * 1024;

/** The header the gate names the peer in, and the one that proves the gate added it. */
export const PEER_HEADER = "x-ovis-direct-peer";
export const GATE_HEADER = "x-ovis-direct-gate";

export interface GateOptions {
  readonly hostname: string;
  readonly port: number;
  /** the carrier's HTTP server on loopback */
  readonly upstreamPort: number;
  /** a secret the upstream checks in GATE_HEADER */
  readonly secret: string;
  readonly allowed: (address: string) => boolean;
  /** shared by every gate of one carrier: connections per address and in all */
  readonly counts: Map<string, number>;
  /** how the upstream is reached; Bun.connect, and in tests one that is slow to resolve */
  readonly connect?: typeof Bun.connect;
}

interface Side {
  socket: Socket<Conn> | Socket<undefined> | undefined;
  pending: Uint8Array[];
  pendingBytes: number;
  /** the socket whose bytes are written to this side: paused while this side is behind */
  source?: () => Socket<Conn> | Socket<undefined> | undefined;
}

interface Conn {
  readonly source: string;
  head: Uint8Array[];
  headBytes: number;
  deadline: ReturnType<typeof setTimeout> | undefined;
  /** toward the upstream once the head passed */
  up: Side | undefined;
  /** toward the peer */
  down: Side;
  counted: boolean;
  /** the upstream answered 101: from here bytes flow both ways */
  upgraded: boolean;
  /** this connection was ended: nothing more goes either way */
  ended: boolean;
}

const total = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, count) => sum + count, 0);

/** Writes all of `bytes` to the side, holding what the socket did not take until it drains; a side behind pauses its source. */
function send(side: Side, bytes: Uint8Array): boolean {
  if (side.pending.length > 0 || !side.socket) {
    side.pending.push(bytes);
    side.pendingBytes += bytes.byteLength;
  } else {
    const written = side.socket.write(bytes);
    if (written < bytes.byteLength) {
      const rest = bytes.subarray(Math.max(0, written));
      side.pending.push(rest);
      side.pendingBytes += rest.byteLength;
    }
  }
  if (side.pendingBytes > HIGH_BYTES) side.source?.()?.pause();
  return true;
}

function flush(side: Side): void {
  while (side.socket && side.pending.length > 0) {
    const next = side.pending[0]!;
    const written = side.socket.write(next);
    if (written >= next.byteLength) {
      side.pending.shift();
      side.pendingBytes -= next.byteLength;
    } else {
      side.pending[0] = next.subarray(Math.max(0, written));
      side.pendingBytes -= Math.max(0, written);
      break;
    }
  }
  if (side.pendingBytes <= LOW_BYTES) side.source?.()?.resume();
}

const refusal = (status: string): Uint8Array => new TextEncoder().encode(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);

/** The request head's line and headers, or null when it is not a request at all. */
function parseHead(text: string): { line: string; headers: Map<string, string>; raw: string[] } | null {
  // read exactly as an HTTP parser must: CRLF lines only, no other control characters, no folded lines
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(text.replace(/\r\n/g, "")) || /\r\n[ \t]/.test(text)) return null;
  const lines = text.split("\r\n");
  const line = lines.shift() ?? "";
  if (!/^[A-Z]+ \S+ HTTP\/1\.1$/.test(line)) return null;
  const headers = new Map<string, string>();
  const raw: string[] = [];
  for (const header of lines) {
    if (header === "") continue;
    const colon = header.indexOf(":");
    if (colon <= 0) return null;
    const name = header.slice(0, colon).trim().toLowerCase();
    raw.push(header);
    headers.set(name, header.slice(colon + 1).trim());
  }
  return { line, headers, raw };
}

export function openGate(options: GateOptions): TCPSocketListener<Conn> {
  const { counts } = options;
  const release = (conn: Conn): void => {
    if (!conn.counted) return;
    conn.counted = false;
    const left = (counts.get(conn.source) ?? 1) - 1;
    if (left > 0) counts.set(conn.source, left);
    else counts.delete(conn.source);
  };
  const end = (socket: Socket<Conn>): void => {
    const conn = socket.data;
    conn.ended = true;
    if (conn.deadline) clearTimeout(conn.deadline);
    release(conn);
    conn.up?.socket?.end();
    socket.end();
  };
  const forward = async (socket: Socket<Conn>, head: string): Promise<void> => {
    const conn = socket.data;
    const up: Side = { socket: undefined, pending: [new TextEncoder().encode(head)], pendingBytes: head.length, source: () => socket };
    conn.up = up;
    conn.down.source = () => up.socket;
    try {
      up.socket = await (options.connect ?? Bun.connect)({
        hostname: "127.0.0.1", port: options.upstreamPort,
        socket: {
          // the peer may have gone while connecting: then the upstream ends at once and gets nothing
          open: (upstream) => { if (conn.ended) { upstream.end(); return; } up.socket = upstream; flush(up); },
          data: (_upstream, chunk) => {
            // anything but a switch to WebSocket is the whole answer: it goes to the peer and the connection ends,
            // so no further request can ride on it past the head's deadline
            if (!conn.upgraded) {
              if (!Buffer.from(chunk.subarray(0, 13)).toString("latin1").startsWith("HTTP/1.1 101 ")) {
                conn.down.socket?.write(chunk);
                conn.down.socket?.flush();
                end(socket);
                return;
              }
              conn.upgraded = true;
            }
            if (!send(conn.down, chunk)) end(socket);
          },
          drain: () => flush(up),
          close: () => end(socket),
          error: () => end(socket),
        },
      });
      if (conn.ended) { up.socket?.end(); return; }
      flush(up);
    } catch { end(socket); }
  };
  return Bun.listen<Conn>({
    hostname: options.hostname, port: options.port,
    socket: {
      open: (socket) => {
        const source = socket.remoteAddress;
        const conn: Conn = { source, head: [], headBytes: 0, deadline: undefined, up: undefined, down: { socket, pending: [], pendingBytes: 0 }, counted: false, upgraded: false, ended: false };
        socket.data = conn;
        if (!options.allowed(source) || (counts.get(source) ?? 0) >= MAX_CONNECTIONS_PER_SOURCE || total(counts) >= MAX_CONNECTIONS) {
          socket.end();
          return;
        }
        counts.set(source, (counts.get(source) ?? 0) + 1);
        conn.counted = true;
        conn.deadline = setTimeout(() => { if (!conn.up) end(socket); }, DEADLINE_MS);
      },
      data: (socket, chunk) => {
        const conn = socket.data;
        if (!conn.counted) return;
        if (conn.up) {
          // a client sends nothing between its upgrade request and the answer to it
          if (!conn.upgraded) { end(socket); return; }
          if (!send(conn.up, chunk)) end(socket);
          return;
        }
        conn.head.push(chunk);
        conn.headBytes += chunk.byteLength;
        const text = Buffer.concat(conn.head).toString("latin1");
        const stop = text.indexOf("\r\n\r\n");
        if (stop < 0) {
          if (conn.headBytes > HEAD_BYTES) end(socket);
          return;
        }
        if (stop > HEAD_BYTES) { end(socket); return; }
        if (conn.deadline) clearTimeout(conn.deadline);
        conn.deadline = undefined;
        const head = parseHead(text.slice(0, stop));
        const answer = (status: string): void => { socket.write(refusal(status)); end(socket); };
        if (!head) { answer("400 Bad Request"); return; }
        const path = head.line.split(" ")[1] ?? "";
        if (!/^\/v1\/ws(\?|$)/.test(path)) { answer("404 Not Found"); return; }
        // a browser page always names its origin; the apps' sockets name none
        if (head.headers.has("origin")) { answer("403 Forbidden"); return; }
        if (head.headers.get("upgrade")?.toLowerCase() !== "websocket" || !head.headers.has("sec-websocket-key")) { answer("426 Upgrade Required"); return; }
        const kept = head.raw.filter((header) => {
          const name = header.slice(0, header.indexOf(":")).trim().toLowerCase();
          return name !== PEER_HEADER && name !== GATE_HEADER;
        });
        const rebuilt = [head.line, ...kept, `${PEER_HEADER}: ${conn.source}`, `${GATE_HEADER}: ${options.secret}`, "", ""].join("\r\n");
        const after = Buffer.concat(conn.head).subarray(stop + 4);
        conn.head = [];
        if (after.byteLength > 0) { end(socket); return; }
        void forward(socket, rebuilt);
      },
      drain: (socket) => flush(socket.data.down),
      close: (socket) => end(socket),
      error: (socket) => end(socket),
    },
  });
}
