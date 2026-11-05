/**
 * The Ovis relay on Cloudflare, at relay.ovis.sh (README.md). The Worker answers `/health` and
 * checks each socket request (core.ts `admit`, rate limits included) before handing it to the
 * Durable Object of its `server_id`, so a refused request never wakes one. The Durable Object
 * holds the room's sockets through the WebSocket Hibernation API: who each socket is lives in its
 * attachment, so the object may be evicted between frames and the room picks up where it was.
 * The PC's keepalive is answered by the runtime itself (`setWebSocketAutoResponse`), so an idle
 * PC never wakes it; an alarm closes sockets idle for IDLE_MS.
 *
 * Usage counters (core.ts `UsageReport`) go to the `USAGE` Workers Analytics Engine dataset, one
 * data point per report, under a hash of the server_id; README.md has the query.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { CLOSE, IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, Room, admit, parseSocketRequest, type Frame, type RateLimiter, type RoomHost, type SocketInfo, type UsageReport } from "./core.ts";

/** the part of a Cloudflare server-side WebSocket the relay uses */
export interface HibernatableSocket {
  send(frame: Frame): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** the part of DurableObjectState the relay uses */
export interface RelayState {
  acceptWebSocket(socket: HibernatableSocket, tags?: string[]): void;
  getWebSockets(tag?: string): HibernatableSocket[];
  setWebSocketAutoResponse(pair?: unknown): void;
  getWebSocketAutoResponseTimestamp(socket: HibernatableSocket): Date | null;
  storage: { getAlarm(): Promise<number | null>; setAlarm(time: number): Promise<void> };
}

interface DurableObjectStub { fetch(request: Request): Promise<Response> }
export interface Env {
  RELAY: { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub };
  /** Cloudflare's Rate Limiting binding (wrangler.toml), keyed by the connecting address */
  RELAY_LIMITER: RateLimiter;
  /** the backstop over all addresses together */
  RELAY_GLOBAL_LIMITER: RateLimiter;
  /** Workers Analytics Engine dataset for usage counters (wrangler.toml); without it nothing is counted */
  USAGE?: { writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void };
}

/** the key a PC's usage is kept under: not its server_id itself */
export const usageKey = (serverId: string) => bytesToHex(sha256(utf8ToBytes(`ovis-relay-usage-v1:${serverId}`))).slice(0, 32);

/**
 * One report as a data point: index1 the PC's usage key, blob1 the side (`pc` or `device`),
 * double1 bytes up (device to PC), double2 bytes down, double3 seconds connected, double4 sessions
 * that ended (1 or 0).
 */
export const usagePoint = (report: UsageReport) => ({
  indexes: [usageKey(report.server_id)],
  blobs: [report.side],
  doubles: [report.up, report.down, report.ms / 1000, report.ended ? 1 : 0],
});

const isUsage = (value: unknown) => typeof value === "object" && value !== null
  && ["since", "up", "down"].every((key) => typeof (value as Record<string, unknown>)[key] === "number");

/** the Workers runtime's globals the Durable Object needs (tests put fakes in their place) */
interface Runtime {
  WebSocketPair: new () => { 0: HibernatableSocket; 1: HibernatableSocket };
  WebSocketRequestResponsePair: new (request: string, response: string) => unknown;
}
const runtime = () => globalThis as unknown as Runtime;

const ROLES = new Set(["control", "data", "client"]);
function isInfo(value: unknown): value is SocketInfo {
  if (typeof value !== "object" || value === null) return false;
  const info = value as Record<string, unknown>;
  const proof = info["proof"] as Record<string, unknown> | undefined;
  return typeof info["role"] === "string" && ROLES.has(info["role"]) && (info["connection_id"] === null || typeof info["connection_id"] === "string")
    && typeof info["seen"] === "number" && typeof info["buffered"] === "boolean"
    && (info["answered"] === undefined || info["answered"] === true)
    && (info["deadline"] === undefined || typeof info["deadline"] === "number")
    && (info["arrived"] === undefined || typeof info["arrived"] === "number")
    && (proof === undefined || (typeof proof === "object" && proof !== null && typeof proof["expected"] === "string" && typeof proof["expires"] === "number"))
    && (info["server_id"] === undefined || typeof info["server_id"] === "string")
    && (info["usage"] === undefined || isUsage(info["usage"]));
}

export class RelayRoom {
  private readonly room: Room<HibernatableSocket>;
  /** alarm reads and writes, one after another, so a later one never undoes an earlier one */
  private alarmWrites: Promise<void> = Promise.resolve();

  constructor(private readonly state: RelayState, env?: Pick<Env, "USAGE">) {
    state.setWebSocketAutoResponse(new (runtime().WebSocketRequestResponsePair)(KEEPALIVE_PING, KEEPALIVE_PONG));
    const infos = new WeakMap<HibernatableSocket, SocketInfo>();
    const host: RoomHost<HibernatableSocket> = {
      sockets: () => state.getWebSockets(),
      info: (socket) => {
        let info = infos.get(socket);
        if (!info) {
          const saved = socket.deserializeAttachment();
          if (!isInfo(saved)) return null;
          info = saved;
          infos.set(socket, info);
        }
        return info;
      },
      setInfo: (socket, info) => {
        infos.set(socket, info);
        socket.serializeAttachment(info);
      },
      send: (socket, frame) => {
        try { socket.send(frame); } catch {
          // Finish the current room operation before propagating failure: a send may happen
          // while a pair is attaching. Do not rely on a later runtime close event to end it.
          queueMicrotask(() => {
            try { socket.close(CLOSE.RESTART, "relay send failed"); } catch { /* already closed */ }
            this.room.closed(socket);
          });
        }
      },
      close: (socket, code, reason) => {
        // closing a socket that is already closed throws; it is gone either way
        try { socket.close(code, reason); } catch { /* see above */ }
      },
      keepaliveAt: (socket) => state.getWebSocketAutoResponseTimestamp(socket)?.getTime() ?? null,
      usage: (report) => env?.USAGE?.writeDataPoint(usagePoint(report)),
      wake: (at) => { void this.armBy(at); },
      now: () => Date.now(),
    };
    this.room = new Room(host);
  }

  async fetch(request: Request): Promise<Response> {
    const socket = parseSocketRequest(new URL(request.url));
    if ("error" in socket) return new Response(socket.error, { status: 400 });
    const pair = new (runtime().WebSocketPair)();
    this.state.acceptWebSocket(pair[1]);
    this.room.open(pair[1], socket);
    await this.armBy(Date.now() + IDLE_MS);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }

  /** clients this instance closed 1012 because the frames held for them were lost in an eviction */
  get heldFramesLost(): number {
    return this.room.heldFramesLost;
  }

  /** makes sure the alarm fires by `at`: sets it unless one is set sooner */
  private armBy(at: number): Promise<void> {
    // a failed earlier write must not stop every later one
    this.alarmWrites = this.alarmWrites.catch(() => undefined).then(async () => {
      const current = await this.state.storage.getAlarm();
      if (current === null || at < current) await this.state.storage.setAlarm(at);
    });
    return this.alarmWrites;
  }

  webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer): void {
    this.room.message(socket, message);
  }

  webSocketClose(socket: HibernatableSocket, code?: number, reason?: string, _wasClean?: boolean): void {
    this.room.closed(socket);
    // A hibernatable socket's close is not answered by the runtime: without this the peer waits in
    // CLOSING until its own timeout (a phone showed itself connected for 17 s) and counts the drop
    // as 1006. The code is echoed when it is 1000 or 3000-4999; any other is answered 1000.
    const echo = code !== undefined && (code === 1000 || (code >= 3000 && code <= 4999));
    try { socket.close(echo ? code : 1000, echo ? reason ?? "" : ""); } catch { /* already closed */ }
  }

  webSocketError(socket: HibernatableSocket): void {
    this.room.closed(socket);
  }

  async alarm(): Promise<void> {
    const next = this.room.sweep();
    // the alarm that fired is spent: set the next one outright
    if (next !== null) await (this.alarmWrites = this.alarmWrites.catch(() => undefined).then(() => this.state.storage.setAlarm(Math.max(next, Date.now() + 1000))));
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const admitted = await admit(request, request.headers.get("cf-connecting-ip") ?? "", { perAddress: env.RELAY_LIMITER, global: env.RELAY_GLOBAL_LIMITER });
  if (admitted instanceof Response) return admitted;
  return env.RELAY.get(env.RELAY.idFromName(admitted.server_id)).fetch(request);
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
