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
import { CLOSE, IDLE_MS, KEEPALIVE_PING, KEEPALIVE_PONG, Room, admit, parseSocketRequest, passRefusal, type Frame, type RateLimiter, type RoomAuthorization, type RoomHost, type SocketInfo, type UsageReport } from "./core.ts";
import { PASS_OFF, passPolicy, type PassPolicy, type PassResult, type PassSettings } from "./pass.ts";
import { PairRoom, isPairInfo, parsePairRequest, type PairInfo } from "./pair-room.ts";

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
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  storage: {
    getAlarm(): Promise<number | null>;
    setAlarm(time: number): Promise<void>;
    get<T>(key: string): Promise<T | undefined>;
    put<T>(key: string, value: T): Promise<void>;
  };
}

interface DurableObjectStub { fetch(request: Request): Promise<Response> }
export interface Env extends PassSettings {
  RELAY: { idFromName(name: string): unknown; get(id: unknown): DurableObjectStub };
  /** Cloudflare's Rate Limiting binding (wrangler.toml), keyed by the connecting address */
  RELAY_LIMITER: RateLimiter;
  /** the backstop over all addresses together */
  RELAY_GLOBAL_LIMITER: RateLimiter;
  /** keyed by server_id, for a PC whose relay pass holds (core.ts Limiters.perPc); without it and RELAY_PASS_CHECK_LIMITER every PC counts under its address */
  RELAY_PC_LIMITER?: RateLimiter;
  /** keyed by the address: the passes it may have checked before its own limit */
  RELAY_PASS_CHECK_LIMITER?: RateLimiter;
  /** Workers Analytics Engine dataset for usage counters (wrangler.toml); without it nothing is counted */
  USAGE?: { writeDataPoint(point: { indexes: string[]; blobs: string[]; doubles: number[] }): void };
}

/**
 * The pass check's result, from the Worker to the Durable Object it hands the socket to. The Worker
 * sets it after checking the pass and drops any copy the request came with; the Durable Object is
 * reached only through the Worker, so it trusts it and checks no signature again.
 */
const PASS_CHECKED = "x-ovis-relay-pass-checked";
/** the key the room's pass authorization is kept under in Durable Object storage */
const PASS_UNTIL = "pass_until";

let policyCache: { key: string; policy: Promise<PassPolicy> } | undefined;
/** The pass policy of these settings, read once per isolate. */
export function policyOf(env: PassSettings): Promise<PassPolicy> {
  const key = JSON.stringify([env.RELAY_PASS_MODE, env.RELAY_PASS_ENFORCE_AT, env.RELAY_PASS_KEYS, env.RELAY_PASS_REVOKED]);
  // settings that do not parse turn passes off rather than stop the relay routing anything
  if (policyCache?.key !== key) policyCache = { key, policy: passPolicy(env).catch((error: unknown) => {
    console.error(JSON.stringify({ event: "relay.pass.settings_invalid", error: error instanceof Error ? error.message : String(error) }));
    return PASS_OFF;
  }) };
  return policyCache.policy;
}

function isPassResult(value: unknown): value is PassResult {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return ["ok", "missing", "invalid", "expired"].includes(result["state"] as string)
    && (result["reason"] === undefined || typeof result["reason"] === "string")
    && (result["exp"] === undefined || typeof result["exp"] === "number")
    && (result["kid"] === undefined || typeof result["kid"] === "string")
    && (result["noNew"] === undefined || result["noNew"] === true);
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

const ROLES = new Set(["control", "data", "client", "warm"]);
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
    && (info["generation"] === undefined || typeof info["generation"] === "string")
    && (info["usage"] === undefined || isUsage(info["usage"]))
    && (info["pass_exp"] === undefined || typeof info["pass_exp"] === "number")
    && (info["pass_kid"] === undefined || typeof info["pass_kid"] === "string")
    && (info["pass_no_new"] === undefined || info["pass_no_new"] === true)
    && (info["pass_state"] === undefined || ["ok", "missing", "invalid", "expired"].includes(info["pass_state"] as string))
    && (info["ended"] === undefined || info["ended"] === true);
}

export class RelayRoom {
  private readonly room: Room<HibernatableSocket>;
  /** a pairing rendezvous (pair-room.ts): its Durable Object is named for its nameplate and holds no PC's sockets */
  private readonly pairRoom: PairRoom<HibernatableSocket>;
  /** alarm reads and writes, one after another, so a later one never undoes an earlier one */
  private alarmWrites: Promise<void> = Promise.resolve();
  /** the pass policy and this room's authorization, read before the first event reaches the object */
  private policy: PassPolicy | undefined;
  private passUntil: RoomAuthorization | null = null;
  /** the saved authorization, read once and only for a PC's room while passes are on: off, and pairing rooms, never touch storage */
  private passLoad: Promise<void> | undefined;
  private passLoaded = false;

  private loadPass(): Promise<void> | undefined {
    if (this.passLoaded || !this.policy || this.policy.mode === "off") return undefined;
    this.passLoad ??= this.state.storage.get<unknown>(PASS_UNTIL).then((saved) => {
      const value = typeof saved === "object" && saved !== null ? saved as Partial<RoomAuthorization> : {};
      this.passUntil = typeof value.until === "number" && typeof value.kid === "string" ? { until: value.until, kid: value.kid, ...(value.noNew === true ? { noNew: true as const } : {}) } : null;
      this.passLoaded = true;
    });
    return this.passLoad;
  }

  constructor(private readonly state: RelayState, env?: Pick<Env, "USAGE"> & PassSettings) {
    void state.blockConcurrencyWhile(async () => { this.policy = env ? await policyOf(env) : undefined; });
    const room = this;
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
        // a socket whose send just failed may refuse its attachment too; it is being ended either way
        try { socket.serializeAttachment(info); } catch { /* see above */ }
      },
      send: (socket, frame) => {
        try { socket.send(frame); } catch {
          // Finish the current room operation before propagating failure: a send may happen
          // while a pair is attaching. Do not rely on a later runtime close event to end it.
          queueMicrotask(() => this.room.end(socket, CLOSE.RESTART, "relay send failed"));
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
      get pass() {
        const policy = room.policy;
        if (!policy || policy.mode === "off") return undefined;
        return {
          policy,
          until: () => room.passUntil,
          setUntil: (value: RoomAuthorization) => {
            room.passUntil = value;
            void state.storage.put(PASS_UNTIL, value);
          },
        };
      },
    };
    this.room = new Room(host);
    const pairInfos = new WeakMap<HibernatableSocket, PairInfo>();
    this.pairRoom = new PairRoom<HibernatableSocket>({
      sockets: host.sockets,
      info: (socket) => {
        let info = pairInfos.get(socket);
        if (!info) {
          const saved = socket.deserializeAttachment();
          if (!isPairInfo(saved)) return null;
          info = saved;
          pairInfos.set(socket, info);
        }
        return info;
      },
      setInfo: (socket, info) => {
        pairInfos.set(socket, info);
        try { socket.serializeAttachment(info); } catch { /* being ended either way */ }
      },
      send: (socket, frame) => {
        try { socket.send(frame); } catch { queueMicrotask(() => this.pairRoom.end(socket, CLOSE.GOING_AWAY, "relay send failed")); }
      },
      close: host.close,
      wake: host.wake,
      keepaliveAt: host.keepaliveAt,
      now: host.now,
      get pass() { return room.policy; },
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const socket = url.pathname === "/v1/pair" ? parsePairRequest(url) : parseSocketRequest(url);
    if ("error" in socket) return new Response(socket.error, { status: 400 });
    const pair = new (runtime().WebSocketPair)();
    this.state.acceptWebSocket(pair[1]);
    let pass: unknown;
    try { pass = JSON.parse(request.headers.get(PASS_CHECKED) ?? "null"); } catch { pass = null; }
    const checked = isPassResult(pass) ? { pass } : {};
    if ("kind" in socket) this.pairRoom.open(pair[1], { ...socket, ...checked });
    else {
      await this.loadPass();
      this.room.open(pair[1], { ...socket, ...checked });
    }
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

  webSocketMessage(socket: HibernatableSocket, message: string | ArrayBuffer): void | Promise<void> {
    if (this.pairRoom.owns(socket)) return this.pairRoom.message(socket, message);
    const loading = this.loadPass();
    return loading ? loading.then(() => this.room.message(socket, message)) : this.room.message(socket, message);
  }

  webSocketClose(socket: HibernatableSocket, code?: number, reason?: string, _wasClean?: boolean): void {
    if (this.pairRoom.owns(socket)) this.pairRoom.closed(socket);
    else this.room.closed(socket);
    // A hibernatable socket's close is not answered by the runtime: without this the peer waits in
    // CLOSING until its own timeout (a phone showed itself connected for 17 s) and counts the drop
    // as 1006. The code is echoed when it is 1000 or 3000-4999; any other is answered 1000.
    const echo = code !== undefined && (code === 1000 || (code >= 3000 && code <= 4999));
    try { socket.close(echo ? code : 1000, echo ? reason ?? "" : ""); } catch { /* already closed */ }
  }

  webSocketError(socket: HibernatableSocket): void {
    if (this.pairRoom.owns(socket)) this.pairRoom.closed(socket);
    else this.room.closed(socket);
  }

  async alarm(): Promise<void> {
    if (!this.room.empty) await this.loadPass();
    const roomNext = this.room.sweep();
    const pairNext = this.pairRoom.sweep();
    const next = roomNext === null ? pairNext : pairNext === null ? roomNext : Math.min(roomNext, pairNext);
    // the alarm that fired is spent: set the next one outright
    if (next !== null) await (this.alarmWrites = this.alarmWrites.catch(() => undefined).then(() => this.state.storage.setAlarm(Math.max(next, Date.now() + 1000))));
  }
}

export async function handle(request: Request, env: Env): Promise<Response> {
  const policy = await policyOf(env);
  const limiters = { perAddress: env.RELAY_LIMITER, global: env.RELAY_GLOBAL_LIMITER,
    ...(env.RELAY_PC_LIMITER && env.RELAY_PASS_CHECK_LIMITER ? { perPc: env.RELAY_PC_LIMITER, passChecks: env.RELAY_PASS_CHECK_LIMITER } : {}) };
  const admitted = await admit(request, request.headers.get("cf-connecting-ip") ?? "", limiters, policy);
  if (admitted instanceof Response) return admitted;
  // a PC socket refused for its pass closes here, so it wakes no Durable Object (an HTTP refusal would reach the PC as a bare 1006)
  const refused = passRefusal(admitted, policy, Date.now());
  if (refused !== null) {
    const pair = new (runtime().WebSocketPair)();
    (pair[1] as HibernatableSocket & { accept?(): void }).accept?.();
    pair[1].close(CLOSE.RELAY_PASS, refused);
    return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
  }
  const headers = new Headers(request.headers);
  headers.delete(PASS_CHECKED);
  if (admitted.pass) headers.set(PASS_CHECKED, JSON.stringify(admitted.pass));
  // a pairing room's name cannot be a server_id, which is 32 hex digits
  return env.RELAY.get(env.RELAY.idFromName("kind" in admitted ? `pair:${admitted.nameplate}` : admitted.server_id)).fetch(new Request(request, { headers }));
}

export default {
  fetch: (request: Request, env: Env) => handle(request, env),
};
