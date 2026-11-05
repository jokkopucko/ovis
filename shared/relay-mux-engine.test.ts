import { afterEach, describe, expect, it } from "bun:test";
import { OutputWindow, OUTPUT_HARD_BYTES, OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_STALL_MS } from "../server/output-window.ts";
import { HttpStream, MuxEngine, MuxStreamError, MUX_FLIGHT, MUX_RECEIVE_RESERVATION_BYTES, WsStream } from "./relay-mux-engine.ts";
import type { MuxClock, MuxOptions, WsClose } from "./relay-mux-engine.ts";
import { decodeFrame, encodeFrame, FrameType, LIMITS_V1, MuxProtocolError, WS_CONTINUATION_CAPACITY, WS_START_CAPACITY } from "./relay-mux.ts";
import type { HeaderList, MuxFrame } from "./relay-mux.ts";

const KiB = 1024;
const MiB = 1024 * KiB;
const device = "0123456789abcdef";
const U64_MAX = 0xffffffffffffffffn;

function deferred<T>() {
  let resolve = (_value: T): void => { throw new Error("Uninitialized barrier"); };
  let reject = (_error: unknown): void => { throw new Error("Uninitialized barrier"); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}
function outcome(promise: Promise<void>): Promise<unknown> { return promise.catch((error: unknown) => error); }
function frame<T extends MuxFrame>(value: T): Uint8Array { return encodeFrame(value); }
function data(id: number, length: number): Uint8Array {
  return frame({ type: FrameType.HTTP_DATA, flags: 0, stream_id: id, payload: new Uint8Array(length) });
}
function credit(id: number, bytes: bigint): Uint8Array {
  return frame({ type: FrameType.CREDIT, flags: 0, stream_id: id, payload: bytes });
}
function receipt(through: bigint): Uint8Array { return frame({ type: FrameType.RECEIVED, flags: 0, stream_id: 0, payload: through }); }
function headers(id: number, status = 200, list: HeaderList = []): Uint8Array {
  return frame({ type: FrameType.HTTP_HEADERS, flags: 0, stream_id: id, payload: { status, headers: list } });
}
function end(id: number, flags = 0, trailers: HeaderList = []): Uint8Array {
  return frame({ type: FrameType.HTTP_END, flags, stream_id: id, payload: { trailers } });
}
function open(id: number, kind: "http" | "ws" = "http", target = "/api/test"): Uint8Array {
  return kind === "http"
    ? frame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: id, payload: { device_id: device, method: "GET", target, headers: [], body: "none" } })
    : frame({ type: FrameType.WS_OPEN, flags: 0, stream_id: id, payload: { device_id: device, target, headers: [], protocols: [] } });
}

class Clock implements MuxClock {
  time = 0;
  private next = 0;
  readonly tasks = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, milliseconds: number): () => void {
    const id = ++this.next;
    this.tasks.set(id, { at: this.time + milliseconds, callback });
    return () => { this.tasks.delete(id); };
  }
  advance(milliseconds: number): void {
    const target = this.time + milliseconds;
    let budget = 100_000;
    for (;;) {
      const next = [...this.tasks].filter(([, task]) => task.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      if (--budget === 0) throw new Error("Timer did not quiesce");
      this.time = next[1].at;
      this.tasks.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

interface Trace {
  readonly side: "client" | "server";
  readonly type: MuxFrame["type"];
  readonly id: number;
  readonly flags: number;
  readonly bytes: number;
  readonly value?: bigint;
}
interface PairOptions {
  readonly onHttp?: (stream: HttpStream) => void;
  readonly onWs?: (stream: WsStream) => void;
  readonly wireMode?: "binary" | "base64";
  readonly trace?: boolean;
}
const engines: MuxEngine[] = [];
afterEach(() => { for (const engine of engines.splice(0)) engine.carrierLost(); });

function pair(options: PairOptions = {}) {
  const clock = new Clock();
  const traces: Trace[] = [];
  const http: HttpStream[] = [];
  const ws: WsStream[] = [];
  const closes: { side: string; code: number }[] = [];
  const errors: MuxProtocolError[] = [];
  const held: { side: "client" | "server"; bytes: Uint8Array }[] = [];
  const hold = { client: false, server: false };
  const calls = { client: 0, server: 0 };
  const peaks = { buffered: 0, queued: 0, inbound: 0, bulk: 0, ordinary: 0, control: 0 };
  let client: MuxEngine;
  let server: MuxEngine;
  let intercept: ((side: "client" | "server", frame: MuxFrame) => void | Promise<void>) | undefined;
  const wireCost = (bytes: Uint8Array) => options.wireMode === "base64" ? Math.ceil((bytes.length + 24) / 3) * 4 : bytes.length + 24;
  const sample = () => {
    for (const engine of [client, server]) {
      const stats = engine.stats;
      peaks.buffered = Math.max(peaks.buffered, stats.bufferedBytes);
      peaks.queued = Math.max(peaks.queued, stats.queuedBytes);
      peaks.inbound = Math.max(peaks.inbound, stats.inboundBytes);
      peaks.bulk = Math.max(peaks.bulk, stats.bulkFlightBytes);
      peaks.ordinary = Math.max(peaks.ordinary, stats.ordinaryFlightBytes);
      peaks.control = Math.max(peaks.control, stats.controlFlightBytes);
    }
  };
  const make = (role: "client" | "server") => new MuxEngine({
    role, clock, outboundWireByteLength: wireCost, routingOverhead: 12, maxWireMessageBytes: 32 * KiB,
    send: async (bytes) => {
      // Simulated transport serialization advances the injected monotonic clock, not wall time.
      clock.advance(1);
      calls[role]++;
      const decoded = decodeFrame(bytes);
      if (options.trace !== false) traces.push({
        side: role, type: decoded.type, id: decoded.stream_id, flags: decoded.flags, bytes: bytes.length,
        ...(typeof decoded.payload === "bigint" ? { value: decoded.payload } : {}),
      });
      const stopped = intercept?.(role, decoded);
      if (stopped) await stopped;
      if (hold[role]) held.push({ side: role, bytes });
      else (role === "client" ? server : client).receive(bytes);
      sample();
    },
    close: (code) => { closes.push({ side: role, code }); },
    onClose: (error) => { errors.push(error); },
    onHttp: (stream) => { http.push(stream); options.onHttp?.(stream); },
    onWs: (stream) => { ws.push(stream); options.onWs?.(stream); },
    requestTimeoutMs: () => 0,
  });
  client = make("client");
  server = make("server");
  engines.push(client, server);
  client.authenticate(device);
  server.authenticate(device);
  return {
    client, server, clock, traces, http, ws, hold, held, calls, peaks, closes, errors, sample,
    intercept(callback: typeof intercept) { intercept = callback; },
    async flush() {
      // Subscribe to sender-idle transitions. No time-based settling or fixed microtask count.
      let budget = 10_000;
      do {
        if (--budget === 0) throw new Error("Sender/receipt loop did not quiesce");
        await Promise.all([client.flush(), server.flush()]);
      } while (!client.senderIdle || !server.senderIdle);
      sample();
    },
    release() {
      for (const entry of held.splice(0)) (entry.side === "client" ? server : client).receive(entry.bytes);
    },
  };
}

function endpoint(role: "client" | "server" = "client", overrides: Partial<MuxOptions> = {}) {
  const clock = new Clock();
  const sent: MuxFrame[] = [];
  const closes: number[] = [];
  const errors: MuxProtocolError[] = [];
  const http: HttpStream[] = [];
  const ws: WsStream[] = [];
  const engine = new MuxEngine({
    role, clock, send: async (bytes) => { sent.push(decodeFrame(bytes)); }, close: (code) => { closes.push(code); },
    outboundWireByteLength: (bytes) => bytes.length + 24, routingOverhead: 0, maxWireMessageBytes: 32 * KiB,
    onClose: (error) => { errors.push(error); }, onHttp: (stream) => { http.push(stream); }, onWs: (stream) => { ws.push(stream); },
    requestTimeoutMs: () => 0, ...overrides,
  });
  engines.push(engine);
  engine.authenticate(device);
  return { engine, clock, sent, closes, errors, http, ws };
}
async function download(e: ReturnType<typeof endpoint>, method: "GET" | "HEAD" = "GET") {
  const stream = e.engine.openHttp({ method, target: "/file", headers: [], body: "none" });
  await e.engine.flush();
  return stream;
}
async function socket(p: ReturnType<typeof pair>, target = "/ws") {
  const local = p.client.openWs({ target, headers: [], protocols: ["ovis"] });
  await p.flush();
  const remote = required(p.ws.at(-1));
  remote.accept("ovis");
  await p.flush();
  return { local, remote };
}
function source(length: number, chunkSize = 64 * KiB) {
  let offset = 0;
  let cancelled = 0;
  const hasher = new Bun.CryptoHasher("sha256");
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === length) { controller.close(); return; }
      const data = new Uint8Array(Math.min(length - offset, chunkSize));
      for (let i = 0; i < data.length; i++) data[i] = (offset + i * 31) & 255;
      offset += data.length;
      hasher.update(data);
      controller.enqueue(data);
    },
    cancel() { cancelled++; },
  }, { highWaterMark: 0 });
  return { body, digest: () => hasher.digest("hex"), produced: () => offset, cancelled: () => cancelled };
}
async function digest(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let bytes = 0;
  const hash = new Bun.CryptoHasher("sha256");
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.length;
    hash.update(next.value);
  }
  return { bytes, digest: hash.digest("hex") };
}
async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  for (;;) {
    const next = await reader.read();
    if (next.done) return result + decoder.decode();
    result += decoder.decode(next.value, { stream: true });
  }
}

describe("stream IDs and retirement", () => {
  it("allocates IDs at selection, consumes refused IDs, and cancels before OPEN without an ID", async () => {
    const p = pair();
    const cancelled = p.client.openHttp({ method: "GET", target: "/cancelled", headers: [], body: "none" });
    const bulk = p.client.openHttp({ method: "GET", target: "/file", headers: [], body: "none" });
    const interactive = p.client.openWs({ target: "/ws?machine_id=pc", headers: [], protocols: [] });
    expect(cancelled.id).toBeUndefined();
    cancelled.reset();
    await p.flush();
    expect(interactive.id).toBe(1);
    expect(bulk.id).toBe(3);
    required(p.ws[0]).reset("refused");
    await p.flush();
    const next = p.client.openHttp({ method: "GET", target: "/next", headers: [], body: "none" });
    await p.flush();
    expect(next.id).toBe(5);
    expect(p.server.stats.lastOpenId).toBe(5);
  });
  for (const bad of ["duplicate", "skipped", "even", "high-bit", "future"] as const) {
    it(`rejects ${bad} stream IDs`, async () => {
      const e = endpoint("server");
      e.engine.receive(open(1));
      const bytes = bad === "future" ? data(3, 1) : open(bad === "skipped" ? 5 : 1);
      if (bad === "even") new DataView(bytes.buffer).setUint32(4, 2);
      if (bad === "high-bit") new DataView(bytes.buffer).setUint32(4, 0x80000001);
      e.engine.receive(bytes);
      await e.engine.flush();
      expect(e.errors[0]?.code).toBe("protocol_error");
      expect(e.closes).toEqual([4000]);
    });
  }
  it("exhausts the last ID with GOAWAY and never wraps", async () => {
    const e = endpoint();
    // Reach the u31 boundary without allocating a billion streams.
    Reflect.set(e.engine, "lastOpenId", 0x7ffffffd);
    const last = e.engine.openHttp({ method: "GET", target: "/last", headers: [], body: "none" });
    await e.engine.flush();
    expect(last.id).toBe(0x7fffffff);
    expect(e.sent.find((f) => f.type === FrameType.GOAWAY)?.payload).toEqual({ code: "id_exhausted", last_open_id: 0x7fffffff, drain_ms: 5000 });
    expect(() => e.engine.openHttp({ method: "GET", target: "/wrapped", headers: [], body: "none" })).toThrow();
  });
  it("retains unread END and pending cleanup, then discards retired stream traffic", async () => {
    const e = endpoint();
    const stream = await download(e);
    const cleanup = deferred<void>();
    stream.onDispose = () => cleanup.promise;
    e.engine.receive(headers(1));
    e.engine.receive(data(1, 3));
    e.engine.receive(end(1));
    expect(e.engine.stats.streams).toBe(1);
    expect((await digest(stream.body)).bytes).toBe(3);
    expect(e.engine.stats.streams).toBe(1);
    cleanup.resolve();
    await cleanup.promise;
    expect(e.engine.stats.streams).toBe(0);
    const before = e.engine.stats.receivedFrames;
    for (const bytes of [data(1, 5), credit(1, 900n), end(1), frame({ type: FrameType.WS_CLOSE, flags: 0, stream_id: 1, payload: { code: 1000, reason: "", abort: true } })]) e.engine.receive(bytes);
    await e.engine.flush();
    expect(e.engine.stats.streams).toBe(0);
    expect(e.engine.stats.inboundBytes).toBe(0);
    expect(e.engine.stats.receivedFrames).toBe(before + 4n);
    expect(e.errors).toEqual([]);
  });
  it("RESET aborts cleanup once and drops crossing frames without new credit", async () => {
    const p = pair();
    const stream = p.client.openHttp({ method: "POST", target: "/upload", headers: [], body: "stream" });
    await p.flush();
    const remote = required(p.http[0]);
    let disposed = 0;
    remote.onDispose = () => { disposed++; };
    remote.accept();
    await p.flush();
    remote.reset();
    remote.reset();
    await p.flush();
    const frames = p.server.stats.receivedFrames;
    p.server.receive(data(required(stream.id), 20));
    p.server.receive(credit(required(stream.id), U64_MAX));
    p.server.receive(end(required(stream.id)));
    await p.flush();
    expect(disposed).toBe(1);
    expect(p.server.stats.receivedFrames).toBe(frames + 3n);
    expect(p.server.stats.streams).toBe(0);
    expect(p.server.stats.queuedBytes).toBe(0);
  });
});

describe("HTTP lifecycle", () => {
  it("streams a digest-equal 200 MiB generated download with bounded buffering", async () => {
    const p = pair({ trace: false });
    const local = p.client.openHttp({ method: "GET", target: "/large-file", headers: [], body: "none" });
    await p.flush();
    const remote = required(p.http[0]);
    const generated = source(200 * MiB);
    const reading = digest(local.body);
    remote.headers(200, [["content-length", String(200 * MiB)]]);
    await remote.sendBody(generated.body);
    const result = await reading;
    await p.flush();
    expect(result).toEqual({ bytes: 200 * MiB, digest: generated.digest() });
    expect(p.peaks.inbound).toBeLessThanOrEqual(LIMITS_V1.http_window_bytes);
    expect(p.peaks.queued).toBeLessThanOrEqual(64 * KiB);
    expect(p.peaks.buffered).toBeLessThan(32 * MiB);
    expect(p.peaks.bulk).toBeLessThanOrEqual(MUX_FLIGHT.bulk);
    expect(p.errors).toEqual([]);
    console.log(`streaming: bytes=${result.bytes} sha256=${result.digest} peak_buffered=${p.peaks.buffered} peak_inbound=${p.peaks.inbound}`);
  }, 120_000);
  it("supports full duplex response before upload completes", async () => {
    const p = pair();
    const local = p.client.openHttp({ method: "POST", target: "/duplex", headers: [], body: "stream" });
    await p.flush();
    const remote = required(p.http[0]);
    remote.accept();
    remote.headers(200);
    const requestReader = remote.body.getReader();
    const responseReader = local.body.getReader();
    const requestRead = requestReader.read();
    const responseRead = responseReader.read();
    await Promise.all([local.write(new Uint8Array([1, 2])), remote.write(new Uint8Array([3, 4]))]);
    expect((await requestRead).value).toEqual(new Uint8Array([1, 2]));
    expect((await responseRead).value).toEqual(new Uint8Array([3, 4]));
    expect(local.endedOut).toBe(false);
    expect(remote.endedOut).toBe(false);
    local.end();
    await p.flush();
    remote.end();
    await p.flush();
    expect((await requestReader.read()).done).toBe(true);
    expect((await responseReader.read()).done).toBe(true);
  });
  for (const accepted of [false, true]) {
    it(`keeps an early rejection readable ${accepted ? "after N bytes" : "before ACCEPT"}`, async () => {
      const p = pair();
      const local = p.client.openHttp({ method: "POST", target: "/reject", headers: [["content-length", "999999"]], body: "stream" });
      await p.flush();
      const remote = required(p.http[0]);
      let stopped = 0;
      local.onUploadStopped = () => { stopped++; };
      if (accepted) {
        remote.accept();
        const read = remote.body.getReader().read();
        await local.write(new Uint8Array(1234));
        expect((await read).value?.length).toBe(1234);
      }
      const pending = outcome(local.write(new Uint8Array(100)));
      remote.stopRequest();
      remote.headers(403);
      const reading = text(local.body);
      await remote.write(new TextEncoder().encode("rejected"));
      remote.end();
      await pending;
      expect(await reading).toBe("rejected");
      await p.flush();
      expect(stopped).toBe(1);
      expect(local.response?.status).toBe(403);
      expect(p.errors).toEqual([]);
      expect(p.client.stats.streams).toBe(0);
    });
  }
  it("streams a response producer after stopping the upload", async () => {
    const p = pair();
    const local = p.client.openHttp({ method: "POST", target: "/early", headers: [], body: "stream" });
    await p.flush();
    const remote = required(p.http[0]);
    const generated = source(10);
    const reading = digest(local.body).catch((error: unknown) => error);
    remote.stopRequest();
    remote.headers(403, [["content-length", "10"]]);
    await remote.sendBody(generated.body);
    expect(generated.produced()).toBe(10);
    expect(await reading).toEqual({ bytes: 10, digest: generated.digest() });
    await p.flush();
    expect(p.errors).toEqual([]);
  });
  it("keeps queued response CREDIT when STOP interrupts an upload", async () => {
    const p = pair();
    const local = p.client.openHttp({ method: "POST", target: "/early", headers: [], body: "stream" });
    await p.flush();
    const remote = required(p.http[0]);
    remote.headers(200);
    await remote.write(new Uint8Array(10));
    await p.flush();
    const entered = deferred<void>();
    const release = deferred<void>();
    p.intercept((side, frame) => {
      if (side === "client" && frame.type === FrameType.PING) {
        entered.resolve();
        return release.promise;
      }
    });
    p.client.ping();
    await entered.promise;
    try {
      const reader = local.body.getReader();
      expect((await reader.read()).value?.length).toBe(10);
      expect(local.granted).toBe(0n);
      remote.stopRequest();
      await p.server.flush();
      expect(local.stopped).toBe(true);
      release.resolve();
      await p.flush();
      expect(remote.peerConsumed).toBe(10n);
      expect(local.granted).toBe(10n);
      const reading = reader.read();
      await remote.write(new Uint8Array(1));
      expect((await reading).value?.length).toBe(1);
      remote.end();
      await p.flush();
      expect((await reader.read()).done).toBe(true);
      expect(p.errors).toEqual([]);
    } finally {
      release.resolve();
    }
  });
  for (const order of ["before", "during", "after"] as const) {
    it(`accepts STOP ${order} normal END without double completion`, async () => {
      const p = pair();
      const local = p.client.openHttp({ method: "POST", target: "/stop", headers: [["content-length", "0"]], body: "stream" });
      await p.flush();
      const remote = required(p.http[0]);
      remote.accept();
      await p.flush();
      if (order === "before") remote.stopRequest();
      local.end();
      if (order === "during") remote.stopRequest();
      await p.flush();
      if (order === "after") remote.stopRequest();
      remote.headers(204);
      remote.end();
      await p.flush();
      expect((await digest(local.body)).bytes).toBe(0);
      expect(p.errors).toEqual([]);
      expect(p.server.stats.streams).toBe(0);
      const ends = p.traces.filter((f) => f.side === "client" && f.type === FrameType.HTTP_END);
      expect(ends).toHaveLength(1);
    });
  }
  it("rejects unsolicited STOPPED END and never calls it successful EOF", async () => {
    const e = endpoint("server");
    e.engine.receive(frame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: { device_id: device, method: "POST", target: "/post", headers: [], body: "stream" } }));
    const stream = required(e.http[0]);
    stream.accept();
    const reading = outcome(digest(stream.body).then(() => undefined));
    e.engine.receive(end(1, 1));
    await e.engine.flush();
    expect(await reading).toBeInstanceOf(MuxStreamError);
    expect(e.sent.find((f) => f.type === FrameType.RESET)?.payload).toEqual({ code: "stream_protocol_error", message: "" });
  });
  for (const [method, status, length] of [
    ["GET", 200, undefined], ["GET", 200, "0"], ["HEAD", 200, "100"],
    ["GET", 204, undefined], ["GET", 205, "0"], ["GET", 304, "100"],
  ] as const) {
    it(`handles ${method} ${status} body semantics with length ${length ?? "absent"}`, async () => {
      const e = endpoint();
      const stream = await download(e, method);
      e.engine.receive(headers(1, status, length === undefined ? [] : [["content-length", length]]));
      e.engine.receive(end(1, 0, [["etag", "trailer"]]));
      expect((await digest(stream.body)).bytes).toBe(0);
      expect(stream.trailers).toEqual([["etag", "trailer"]]);
      expect(e.errors).toEqual([]);
    });
  }
  it("preserves binary bytes, duplicate legal headers, and split SSE bytes", async () => {
    const e = endpoint();
    const stream = await download(e);
    const wire = new TextEncoder().encode(":heartbeat\r\ndata: \uD55C\nid: 1\n\n");
    e.engine.receive(headers(1, 200, [["content-type", "text/event-stream"], ["cache-control", "no-cache"], ["cache-control", "no-transform"]]));
    const reading = text(stream.body);
    for (const byte of wire) e.engine.receive(frame({ type: FrameType.HTTP_DATA, flags: 0, stream_id: 1, payload: new Uint8Array([byte]) }));
    e.engine.receive(end(1));
    expect(await reading).toBe(new TextDecoder().decode(wire));
    expect(stream.response?.headers).toHaveLength(3);
  });
  for (const problem of ["short", "long", "missing END", "no body status", "HEAD data", "nine informational", "duplicate final"] as const) {
    it(`errors ${problem} rather than producing successful EOF`, async () => {
      const e = endpoint();
      const stream = await download(e, problem === "HEAD data" ? "HEAD" : "GET");
      const reading = outcome(digest(stream.body).then(() => undefined));
      if (problem === "nine informational") {
        for (let i = 0; i < 9; i++) e.engine.receive(headers(1, 103));
      } else {
        e.engine.receive(headers(1, problem === "no body status" ? 204 : 200, [["content-length", problem === "short" ? "2" : "1"]]));
        if (problem === "duplicate final") e.engine.receive(headers(1));
        else e.engine.receive(data(1, problem === "long" ? 2 : 1));
        if (problem === "missing END") e.engine.carrierLost();
        else e.engine.receive(end(1));
      }
      await e.engine.flush();
      expect(await reading).toBeInstanceOf(MuxStreamError);
    });
  }
  it("allows eight informational responses followed by one final response", async () => {
    const e = endpoint();
    const stream = await download(e);
    for (let i = 0; i < 8; i++) e.engine.receive(headers(1, 103));
    e.engine.receive(headers(1, 200, [["content-length", "1"], ["content-length", "1"]]));
    e.engine.receive(data(1, 1));
    e.engine.receive(end(1));
    expect((await digest(stream.body)).bytes).toBe(1);
    expect(e.errors).toEqual([]);
  });
  it("rejects conflicting lengths and forbidden hop-by-hop metadata at the boundary", async () => {
    for (const fields of [[["content-length", "1"], ["content-length", "2"]], [["transfer-encoding", "chunked"]], [["authorization", "forged"]]] as const) {
      const e = endpoint();
      await download(e);
      const payload = new TextEncoder().encode(JSON.stringify({ status: 200, headers: fields }));
      const bytes = new Uint8Array(payload.length + 8);
      bytes.set([1, FrameType.HTTP_HEADERS, 0, 0, 0, 0, 0, 1]);
      bytes.set(payload, 8);
      e.engine.receive(bytes);
      await e.engine.flush();
      expect(e.errors[0]?.code).toBe("protocol_error");
    }
  });
});

describe("request ceiling", () => {
  for (const declared of [false, true]) for (const delta of [-1, 0, 1]) {
    it(`${declared ? "declared" : "unknown"} length at 64 MiB ${delta < 0 ? "-1" : delta > 0 ? "+1" : "exact"}`, async () => {
      const p = pair({ trace: false });
      const length = 64 * MiB + delta;
      const local = p.client.openHttp({ method: "POST", target: "/upload", headers: declared ? [["content-length", String(length)]] : [], body: "stream" });
      const generated = source(length);
      const sending = outcome(local.sendBody(generated.body));
      const response = digest(local.body);
      await p.flush();
      const remote = p.http[0];
      if (remote) {
        remote.accept();
        const consumed = await digest(remote.body).catch((error: unknown) => error);
        if (delta <= 0) {
          expect(consumed).toEqual({ bytes: length, digest: generated.digest() });
          remote.headers(204);
          remote.end();
        } else expect(consumed).toBeInstanceOf(MuxStreamError);
      }
      await sending;
      expect((await response).bytes).toBe(0);
      await p.flush();
      expect(local.response?.status).toBe(delta > 0 ? 413 : 204);
      if (delta > 0 && declared) expect(generated.produced()).toBeLessThanOrEqual(64 * KiB);
      expect(p.errors).toEqual([]);
      expect(p.client.stats.streams).toBe(0);
      expect(p.server.stats.streams).toBe(0);
    }, 120_000);
  }
  it("resets an oversized unknown upload when final headers already went out", async () => {
    const p = pair({ trace: false });
    const local = p.client.openHttp({ method: "POST", target: "/upload", headers: [], body: "stream" });
    await p.flush();
    const remote = required(p.http[0]);
    remote.accept();
    remote.headers(200);
    const response = outcome(digest(local.body).then(() => undefined));
    const consuming = outcome(digest(remote.body).then(() => undefined));
    const sending = outcome(local.sendBody(source(64 * MiB + 1).body));
    expect(await consuming).toBeInstanceOf(MuxStreamError);
    expect(await response).toBeInstanceOf(MuxStreamError);
    await sending;
    expect(local.cancelled).toBe(true);
    expect(p.errors).toEqual([]);
  }, 120_000);
});

describe("WebSockets", () => {
  for (const length of [0, 1, 16372, 16373, 65536, 65537, MiB]) {
    it(`reassembles ${length} bytes with whole-message credit`, async () => {
      const p = pair();
      const { local, remote } = await socket(p);
      const message = deferred<string | Uint8Array>();
      const accepted = deferred<void>();
      remote.onMessage = (value) => { message.resolve(value); return accepted.promise; };
      const bytes = new Uint8Array(length).fill(0xa5);
      local.send(bytes);
      expect(await message.promise).toEqual(bytes);
      expect(remote.consumed).toBe(0n);
      accepted.resolve();
      await p.flush();
      expect(remote.consumed).toBe(BigInt(length));
      expect(local.peerConsumed).toBe(BigInt(length));
      expect(p.traces.filter((f) => f.side === "client" && f.type === FrameType.WS_DATA)).toHaveLength(length === MiB ? 65 : length <= WS_START_CAPACITY ? 1 : Math.ceil((length - WS_START_CAPACITY) / 16376) + 1);
    });
  }
  it("detects the 64 KiB-window WS credit deadlock counterexample", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    let delivered = 0;
    remote.onMessage = () => { delivered++; };
    local.sendWindow = 64 * KiB; // Deliberately incorrect model of the window, not a production option.
    local.send(new Uint8Array(MiB));
    await p.flush();
    expect(delivered).toBe(0);
    expect(local.sent).toBeGreaterThan(0n);
    expect(local.sent).toBeLessThanOrEqual(65536n);
    expect(local.queuedBytes).toBeGreaterThan(0);
    p.clock.advance(30_000);
    await p.flush();
    expect(local.cancelled).toBe(true);
    expect(p.traces.some((f) => f.type === FrameType.RESET)).toBe(true);
    console.log(`deadlock counterexample: window=65536 delivered=${delivered} cancelled=${local.cancelled}`);
  });
  it("preserves empty text and split UTF-8 text", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    const values: (string | Uint8Array)[] = [];
    const complete = deferred<void>();
    remote.onMessage = (value) => { values.push(value); if (values.length === 2) complete.resolve(); };
    local.send("");
    local.send("a".repeat(16371) + "\uD55C");
    await complete.promise;
    expect(values).toEqual(["", "a".repeat(16371) + "\uD55C"]);
  });
  for (const bad of ["continuation", "repeated START", "premature END", "excess length", "invalid UTF-8", "oversize"] as const) {
    it(`rejects WS ${bad} without exposing a partial message`, async () => {
      const p = pair();
      const { local, remote } = await socket(p);
      let delivered = 0;
      const closed: WsClose[] = [];
      remote.onMessage = () => { delivered++; };
      remote.onClose = (event) => { closed.push(event); };
      // These adversarial frames are not sent by the client engine. Its receipt ledger
      // therefore must not be fed receipts for this independent peer's injected traffic.
      p.hold.server = true;
      const id = required(local.id);
      const start = frame({ type: FrameType.WS_DATA, flags: 1, stream_id: id, payload: { total_message_bytes: 3, data: new Uint8Array([1]) } });
      if (bad !== "continuation" && bad !== "invalid UTF-8" && bad !== "oversize") p.server.receive(start);
      if (bad === "repeated START") p.server.receive(start);
      else if (bad === "invalid UTF-8") p.server.receive(frame({ type: FrameType.WS_DATA, flags: 7, stream_id: id, payload: { total_message_bytes: 1, data: new Uint8Array([0xff]) } }));
      else if (bad === "oversize") {
        const bytes = start.slice();
        new DataView(bytes.buffer).setUint32(8, MiB + 1);
        p.server.receive(bytes);
      } else p.server.receive(frame({ type: FrameType.WS_DATA, flags: 2, stream_id: id, payload: { data: new Uint8Array(bad === "excess length" ? 4 : 1) } }));
      await p.flush();
      expect(delivered).toBe(0);
      if (bad === "invalid UTF-8" || bad === "oversize") {
        expect(closed[0]?.code).toBe(bad === "invalid UTF-8" ? 1007 : 1009);
        expect(p.server.active).toBe(true);
      } else expect(remote.cancelled).toBe(true);
    });
  }
  for (const code of [1000, 1008, 1012, 3000, 4008]) {
    it(`passes through close ${code} on the virtual socket`, async () => {
      const p = pair();
      const { local, remote } = await socket(p);
      const closed = deferred<WsClose>();
      local.onClose = closed.resolve;
      remote.close(code, "closed", code === 4008);
      const result = await closed.promise;
      expect(result).toEqual({ code, reason: "closed", clean: code !== 4008 });
      await p.flush();
      expect(p.closes).toEqual([]);
    });
  }
  it("drains accepted messages before simultaneous graceful close", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    const messages: string[] = [];
    const closed: WsClose[] = [];
    local.onMessage = (value) => { messages.push(String(value)); };
    remote.onMessage = (value) => { messages.push(String(value)); };
    local.onClose = (event) => { closed.push(event); };
    remote.onClose = (event) => { closed.push(event); };
    local.send("out");
    remote.send("back");
    local.close();
    remote.close();
    await p.flush();
    expect(messages.sort()).toEqual(["back", "out"]);
    expect(closed).toHaveLength(2);
    expect(closed.every((event) => event.clean)).toBe(true);
  });
  it("aborts a blocked drain at five seconds without touching other streams", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    const closed: WsClose[] = [];
    local.onClose = (event) => { closed.push(event); };
    remote.onMessage = () => deferred<void>().promise;
    local.send(new Uint8Array(MiB));
    await p.flush();
    local.send("unsent");
    local.close(1000, "drain");
    await p.flush();
    p.clock.advance(4999);
    expect(closed).toHaveLength(0);
    p.clock.advance(1);
    await p.flush();
    expect(closed[0]?.clean).toBe(false);
    expect(local.queuedBytes).toBe(0);
    expect(p.client.active).toBe(true);
  });
  it("fails a missing close exchange at five seconds without a successful close", async () => {
    const e = endpoint();
    const local = e.engine.openWs({ target: "/ws", headers: [], protocols: [] });
    await e.engine.flush();
    e.engine.receive(frame({ type: FrameType.WS_ACCEPT, flags: 0, stream_id: 1, payload: { protocol: null, headers: [] } }));
    const closed: WsClose[] = [];
    local.onClose = (event) => { closed.push(event); };
    local.close();
    await e.engine.flush();
    e.clock.advance(4999);
    expect(closed).toHaveLength(0);
    e.clock.advance(1);
    await e.engine.flush();
    expect(closed).toEqual([{ code: 1006, reason: "", clean: false }]);
    expect(e.engine.active).toBe(true);
  });
  it("does not credit a late message completion after an abort during cleanup", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    const entered = deferred<void>();
    const delivered = deferred<void>();
    const cleanup = deferred<void>();
    remote.onMessage = () => { entered.resolve(); return delivered.promise; };
    remote.onDispose = () => cleanup.promise;
    local.send("input");
    await entered.promise;
    p.hold.client = true;
    remote.close();
    await p.flush();
    p.hold.server = true;
    p.server.receive(frame({ type: FrameType.WS_CLOSE, flags: 0, stream_id: required(remote.id), payload: { code: 4008, reason: "stalled", abort: true } }));
    expect(remote.cleanupPending).toBe(1);
    delivered.resolve();
    await delivered.promise;
    expect(remote.inboundBytes).toBe(0);
    expect(remote.pendingInbound).toBe(0);
    expect(remote.consumed).toBe(0n);
    cleanup.resolve();
    await cleanup.promise;
    expect(remote.retired).toBe(true);
    expect(p.server.stats.reservedBytes).toBe(0);
  });
  it("enforces close reason and reserved code bounds", async () => {
    const p = pair();
    const { local } = await socket(p);
    for (const code of [1004, 1005, 1006, 1015, 2999]) expect(() => local.close(code)).toThrow(MuxProtocolError);
    expect(() => local.close(1000, "a".repeat(124))).toThrow(MuxProtocolError);
    local.close(1000, "a".repeat(123));
    await p.flush();
    expect(p.errors).toEqual([]);
  });
  it("maps rejected upgrades to a streaming HTTP body and the HTTP window", async () => {
    const p = pair();
    const local = p.client.openWs({ target: "/not-a-websocket", headers: [], protocols: [] });
    await p.flush();
    const rejected = required(p.ws[0]).reject(403);
    await p.flush();
    const reading = text(required(local.rejection).body);
    await rejected.write(new TextEncoder().encode("no upgrade"));
    rejected.end();
    expect(await reading).toBe("no upgrade");
    expect(local.rejection?.receiveWindow).toBe(LIMITS_V1.http_window_bytes);
    expect(() => local.send("forbidden")).toThrow();
  });
});

describe("credit and receipts", () => {
  for (const role of ["client", "server"] as const) it(`over-credit DATA closes the ${role} session`, async () => {
    const e = endpoint(role);
    let stream: HttpStream;
    if (role === "client") {
      stream = await download(e);
      e.engine.receive(headers(1));
    } else {
      e.engine.receive(frame({ type: FrameType.HTTP_OPEN, flags: 0, stream_id: 1, payload: {
        device_id: device, method: "POST", target: "/upload", headers: [], body: "stream",
      } }));
      stream = required(e.http[0]);
      stream.accept();
      await e.engine.flush();
    }
    for (let remaining = LIMITS_V1.http_window_bytes; remaining > 0;) {
      const size = Math.min(remaining, WS_CONTINUATION_CAPACITY);
      e.engine.receive(data(1, size));
      remaining -= size;
    }
    expect(stream.received).toBe(BigInt(LIMITS_V1.http_window_bytes));
    expect(e.engine.active).toBe(true);
    e.engine.receive(data(1, 1));
    await e.engine.flush();
    const error = e.sent.find((f) => f.type === FrameType.SESSION_ERROR);
    expect(error?.type === FrameType.SESSION_ERROR && error.payload.code).toBe("flow_control_error");
    expect(e.closes).toEqual([4000]);
    expect(e.engine.stats.inboundBytes).toBe(0);
    console.log(`over-credit DATA: role=${role} received=${LIMITS_V1.http_window_bytes} attempted=${LIMITS_V1.http_window_bytes + 1} SESSION_ERROR=${error?.type === FrameType.SESSION_ERROR ? error.payload.code : "MISSING"} close=${e.closes.join(",")}`);
  });
  it("accounts CREDIT only on read and only once for stale or duplicate values", async () => {
    const p = pair();
    const local = p.client.openHttp({ method: "GET", target: "/file", headers: [], body: "none" });
    await p.flush();
    const remote = required(p.http[0]);
    remote.headers(200);
    await remote.write(new Uint8Array(100));
    await p.flush();
    expect(remote.peerConsumed).toBe(0n);
    expect(local.consumed).toBe(0n);
    const reader = local.body.getReader();
    expect((await reader.read()).value?.length).toBe(100);
    await p.flush();
    expect(remote.peerConsumed).toBe(100n);
    p.hold.server = true; // Injected peer frames have no entries in the client's send ledger.
    p.server.receive(credit(1, 100n));
    p.server.receive(credit(1, 50n));
    await p.flush();
    expect(remote.peerConsumed).toBe(100n);
    p.server.receive(credit(1, 101n));
    await p.flush();
    expect(p.errors.some((error) => error.code === "flow_control_error")).toBe(true);
  });
  it("does not grant CREDIT until its report is actually committed", async () => {
    const e = endpoint();
    const local = await download(e);
    e.engine.receive(headers(1));
    e.engine.receive(data(1, 10));
    const reader = local.body.getReader();
    const reading = reader.read();
    // ReadableStream pull returns storage before the scheduled CREDIT can leave.
    await reading;
    const granted = local.granted;
    expect(granted <= local.consumed).toBe(true);
    await e.engine.flush();
    expect(local.granted).toBe(10n);
  });
  it("enumerates read, CREDIT, duplicate and receipt interleavings", async () => {
    for (const readFirst of [false, true]) for (const receiveReceiptFirst of [false, true]) {
      const e = endpoint();
      const local = await download(e);
      e.engine.receive(headers(1));
      const reading = readFirst ? local.body.getReader().read() : undefined;
      e.engine.receive(data(1, 11));
      if (receiveReceiptFirst) e.engine.receive(receipt(e.engine.stats.submitted));
      if (reading) await reading;
      else await local.body.getReader().read();
      await e.engine.flush();
      if (!receiveReceiptFirst) e.engine.receive(receipt(e.engine.stats.submitted));
      e.engine.receive(receipt(0n));
      await e.engine.flush();
      expect(local.received).toBe(11n);
      expect(local.consumed).toBe(11n);
      expect(local.granted).toBe(11n);
      expect(e.errors).toEqual([]);
    }
  });
  it("rejects u64 overflow instead of wrapping credit counters", async () => {
    const e = endpoint();
    const local = await download(e);
    local.received = U64_MAX;
    local.consumed = local.granted = U64_MAX;
    e.engine.receive(headers(1));
    e.engine.receive(data(1, 1));
    await e.engine.flush();
    expect(e.errors[0]?.code).toBe("flow_control_error");
    expect(local.received).toBe(U64_MAX);
  });
  it("receipt accounting ignores stale values and has no acknowledgement loop", async () => {
    const e = endpoint();
    await download(e);
    const initial = e.engine.stats.ordinaryFlightBytes;
    expect(initial).toBeGreaterThan(0);
    e.engine.receive(receipt(1n));
    await e.engine.flush();
    expect(e.engine.stats.ordinaryFlightBytes).toBe(0);
    const calls = e.sent.length;
    e.engine.receive(receipt(1n));
    e.engine.receive(receipt(0n));
    await e.engine.flush();
    expect(e.sent).toHaveLength(calls);
    expect(e.engine.stats.receivedFrames).toBe(0n);
    e.engine.receive(receipt(2n));
    await e.engine.flush();
    expect(e.errors[0]?.code).toBe("protocol_error");
  });
  for (const mode of ["binary", "base64"] as const) {
    it(`slow-relay counterexample bounds ${mode} flight even when sends resolve immediately`, async () => {
      const p = pair({ wireMode: mode });
      const terminal = await socket(p);
      for (let i = 0; i < 2; i++) p.client.openHttp({ method: "GET", target: `/download/${i}`, headers: [], body: "none" });
      await p.flush();
      const remote = required(p.http[0]);
      for (const stream of p.http) stream.headers(200);
      await p.flush();
      p.hold.server = true;
      const writing = Promise.all(p.http.map((stream) => outcome(stream.write(new Uint8Array(512 * KiB)))));
      await p.flush();
      const wire = (mode === "base64" ? Math.ceil((16384 + 24) / 3) * 4 : 16384 + 24) + 12;
      expect(p.held).toHaveLength(Math.floor(MUX_FLIGHT.bulk / wire));
      expect(p.server.stats.bulkFlightBytes).toBeLessThanOrEqual(MUX_FLIGHT.bulk);
      expect(p.server.stats.bulkFlightBytes).toBeGreaterThan(MUX_FLIGHT.bulk - wire);
      expect(remote.queuedBytes).toBeGreaterThan(0);
      const calls = p.calls.server;
      await p.server.flush();
      expect(p.calls.server).toBe(calls);
      terminal.remote.send(new Uint8Array(WS_START_CAPACITY));
      p.server.ping();
      await p.flush();
      expect(p.held.some((entry) => decodeFrame(entry.bytes).type === FrameType.WS_DATA)).toBe(true);
      expect(p.held.some((entry) => decodeFrame(entry.bytes).type === FrameType.PING)).toBe(true);
      expect(p.server.stats.ordinaryFlightBytes).toBeLessThanOrEqual(MUX_FLIGHT.ordinary);
      expect(p.server.stats.bulkFlightBytes).toBeLessThanOrEqual(MUX_FLIGHT.bulk);
      p.server.carrierLost();
      await writing;
    });
  }
  it("refuses transport overhead that cannot fit the maximum frame", () => {
    expect(() => endpoint("client", { routingOverhead: 9000 })).toThrow(MuxProtocolError);
    expect(() => endpoint("client", { maxWireMessageBytes: 16384 })).toThrow(MuxProtocolError);
  });
  it("caps control flight while receipts bypass a full control window", async () => {
    const e = endpoint();
    for (let i = 0; i < 1024; i++) e.engine.ping();
    await e.engine.flush();
    const control = e.engine.stats.controlFlightBytes;
    expect(control).toBeLessThanOrEqual(16 * KiB);
    expect(control).toBeGreaterThan(16 * KiB - 40);
    expect(e.engine.stats.controlQueuedBytes).toBeGreaterThan(0);
    await download(e);
    expect(e.engine.stats.ordinaryFlightBytes).toBeGreaterThan(0);
    e.engine.receive(frame({ type: FrameType.PONG, flags: 0, stream_id: 0, payload: 1n }));
    await e.engine.flush();
    expect(e.sent.at(-1)?.type).toBe(FrameType.RECEIVED);
    expect(e.engine.stats.controlFlightBytes).toBe(control);
    expect(e.engine.stats.controlFlightBytes + e.engine.stats.ordinaryFlightBytes).toBeLessThanOrEqual(MUX_FLIGHT.total);
  });
});

describe("scheduling and isolation", () => {
  it("fairness", async () => {
    const p = pair();
    const terminal = await socket(p);
    terminal.local.onMessage = () => undefined;
    const sse = p.client.openHttp({ method: "GET", target: "/api/machines/events?pc=1", headers: [], body: "none" });
    const bulk1 = p.client.openHttp({ method: "GET", target: "/download/one", headers: [], body: "none" });
    const bulk2 = p.client.openHttp({ method: "GET", target: "/download/two", headers: [], body: "none" });
    const upload = p.client.openHttp({ method: "POST", target: "/upload", headers: [], body: "stream" });
    await p.flush();
    const eventSource = required(p.http.find((s) => s.request.target.startsWith("/api/machines/events")));
    const file1 = required(p.http.find((s) => s.request.target === "/download/one"));
    const file2 = required(p.http.find((s) => s.request.target === "/download/two"));
    const uploadSink = required(p.http.find((s) => s.request.target === "/upload"));
    uploadSink.accept();
    for (const stream of [eventSource, file1, file2]) stream.headers(200);
    await p.flush();
    const bodies = [digest(sse.body), digest(bulk1.body), digest(bulk2.body), digest(uploadSink.body)];
    let terminalAcks = 0;
    terminal.remote.onMessage = () => { terminalAcks++; };
    const start = p.traces.length;
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 128; i++) {
      terminal.remote.send(new Uint8Array(4096));
      terminal.local.send(`{"type":"pty-ack","offset":${i * 4096}}`);
      writes.push(eventSource.write(new Uint8Array(4096)));
    }
    writes.push(file1.write(new Uint8Array(512 * KiB)), file2.write(new Uint8Array(512 * KiB)));
    writes.push(upload.write(new Uint8Array(512 * KiB)));
    await Promise.all(writes);
    upload.end();
    for (const stream of [eventSource, file1, file2]) stream.end();
    await Promise.all(bodies);
    await p.flush();
    const scheduled = p.traces.slice(start).filter((f) => f.side === "server" && [FrameType.HTTP_DATA, FrameType.WS_DATA].some((type) => type === f.type));
    const interactiveIds = [terminal.remote.id, eventSource.id];
    const classes = scheduled.map((f) => interactiveIds.includes(f.id) ? "I" : "B");
    const firstBulk = classes.indexOf("B");
    const cycle = classes.slice(firstBulk, firstBulk + 30);
    expect(cycle).toEqual(Array.from({ length: 30 }, (_, i) => i % 5 === 0 ? "B" : "I"));
    const interactive = scheduled.filter((f) => interactiveIds.includes(f.id)).slice(0, 20);
    for (let i = 1; i < interactive.length; i++) expect(interactive[i]?.id).not.toBe(interactive[i - 1]?.id);
    const bulk = scheduled.filter((f) => !interactiveIds.includes(f.id)).slice(0, 10);
    for (let i = 1; i < bulk.length; i++) expect(bulk[i]?.id).not.toBe(bulk[i - 1]?.id);
    expect(p.peaks.bulk).toBeLessThanOrEqual(MUX_FLIGHT.bulk);
    expect(terminalAcks).toBe(128);
    console.log("fairness: terminal and SSE frames during saturated downloads");
    console.log(scheduled.slice(0, 35).map((f, i) => `${i}: stream=${f.id} ${interactiveIds.includes(f.id) ? f.id === terminal.remote.id ? "terminal" : "SSE" : "download"} bytes=${f.bytes}`).join("\n"));
    console.log(`fairness: cycle=${cycle.join("")} interactive:bulk=4:1 peak_bulk_flight=${p.peaks.bulk}`);
  });
  it("bounds urgent bursts at eight while ordinary work is ready", async () => {
    const e = endpoint("server");
    e.engine.receive(open(1));
    const stream = required(e.http[0]);
    stream.headers(200);
    const writing = outcome(stream.write(new Uint8Array(100)));
    for (let i = 0; i < 20; i++) e.engine.receive(frame({ type: FrameType.PING, flags: 0, stream_id: 0, payload: BigInt(i) }));
    await e.engine.flush();
    const firstOrdinary = e.sent.findIndex((f) => f.type === FrameType.HTTP_HEADERS);
    expect(firstOrdinary).toBeLessThanOrEqual(8);
    const between = e.sent.slice(firstOrdinary + 1).findIndex((f) => f.type === FrameType.HTTP_DATA);
    expect(between).toBeLessThanOrEqual(8);
    await writing;
  });
  it("all windows exhausted still permits CREDIT RESET PING PONG CLOSE and RECEIVED", async () => {
    const p = pair();
    const first = await socket(p);
    const second = await socket(p, "/ws/two");
    const accepted = deferred<void>();
    first.local.onMessage = first.remote.onMessage = () => accepted.promise;
    first.local.send(new Uint8Array(MiB));
    first.remote.send(new Uint8Array(MiB));
    await p.flush();
    first.local.send("blocked");
    first.remote.send("blocked");
    await p.flush();
    expect(first.local.sent - first.local.peerConsumed).toBe(BigInt(MiB));
    expect(first.remote.sent - first.remote.peerConsumed).toBe(BigInt(MiB));
    const start = p.traces.length;
    p.client.ping();
    second.local.reset();
    accepted.resolve();
    await p.flush();
    first.remote.close(4008, "stalled", true);
    await p.flush();
    const types = p.traces.slice(start).map((f) => f.type);
    for (const type of [FrameType.CREDIT, FrameType.RESET, FrameType.PING, FrameType.PONG, FrameType.WS_CLOSE, FrameType.RECEIVED]) expect(types).toContain(type);
    expect(p.closes).toEqual([]);
  });
  it("terminal queue isolation", async () => {
    const p = pair();
    const terminal = await socket(p);
    const healthy = await socket(p, "/ws/other");
    terminal.local.onMessage = () => undefined;
    healthy.local.onMessage = () => undefined;
    const file = p.client.openHttp({ method: "GET", target: "/download", headers: [], body: "none" });
    await p.flush();
    const remoteFile = required(p.http[0]);
    remoteFile.headers(200);
    const blocked = outcome(remoteFile.write(new Uint8Array(512 * KiB)));
    terminal.remote.send("terminal keeps flowing");
    await p.flush();
    expect(remoteFile.queuedBytes).toBeGreaterThan(0);
    expect(file.inboundBytes).toBeLessThanOrEqual(LIMITS_V1.http_window_bytes);
    expect(terminal.remote.getBufferedAmount()).toBe(0);
    const output = new OutputWindow();
    expect([OUTPUT_HIGH_BYTES, OUTPUT_LOW_BYTES, OUTPUT_HARD_BYTES, OUTPUT_STALL_MS]).toEqual([256 * KiB, 64 * KiB, MiB, 2000]);
    output.write(OUTPUT_HIGH_BYTES);
    expect(output.check(terminal.remote.getBufferedAmount(), p.clock.now())).toBe("pause");
    // Neither mux CREDIT nor RECEIVED is a pty-ack.
    expect(output.acknowledged).toBe(0);
    p.clock.advance(2000);
    expect(output.check(terminal.remote.getBufferedAmount(), p.clock.now())).toBe("stop");
    let detached = 0;
    terminal.remote.onDispose = () => { detached++; };
    const stopped = deferred<WsClose>();
    terminal.local.onClose = stopped.resolve;
    terminal.remote.close(4008, "terminal output consumer stalled", true);
    expect(detached).toBe(1);
    expect(await stopped.promise).toEqual({ code: 4008, reason: "terminal output consumer stalled", clean: false });
    healthy.remote.send("still alive");
    await p.flush();
    expect(healthy.remote.live).toBe(true);
    expect(p.server.active).toBe(true);
    expect(remoteFile.cancelled).toBe(false);
    remoteFile.reset();
    await blocked;
  });
});

describe("limits and liveness", () => {
  for (const kind of ["http", "ws", "sse"] as const) {
    it(`refuses ${kind === "http" ? "stream 33" : kind === "ws" ? "WS 9" : "SSE 5"} without dispatch or leaked reservation`, async () => {
      let dispatched = 0;
      const e = endpoint("server", { onHttp: (stream) => {
        dispatched++;
        if (kind === "sse") stream.headers(200, [["content-type", "text/event-stream"]]);
      }, onWs: () => { dispatched++; } });
      const count = kind === "http" ? 33 : kind === "ws" ? 9 : 5;
      for (let i = 0; i < count; i++) e.engine.receive(open(2 * i + 1, kind === "ws" ? "ws" : "http", kind === "sse" ? "/api/machines/events" : "/api/test"));
      await e.engine.flush();
      expect(e.engine.stats.streams).toBe(count - 1);
      expect(e.sent.some((f) => f.type === FrameType.RESET && f.stream_id === 2 * count - 1 && f.payload.code === "refused")).toBe(true);
      expect(e.engine.stats.reservedBytes).toBe((count - 1) * (kind === "ws" ? MiB : LIMITS_V1.http_window_bytes));
      expect(e.engine.stats.lastOpenId).toBe(2 * count - 1);
      expect(dispatched).toBe(count - 1);
    });
  }
  for (const role of ["client", "server"] as const) {
    it(`reserves bounded mixed receive windows before dispatch on the ${role}`, async () => {
      const e = endpoint(role);
      const openStream = (index: number, kind: "http" | "ws") => {
        if (role === "server") e.engine.receive(open(index * 2 + 1, kind));
        else if (kind === "ws") e.engine.openWs({ target: "/ws", headers: [], protocols: [] });
        else e.engine.openHttp({ method: "GET", target: "/file", headers: [], body: "none" });
      };
      for (let i = 0; i < 8; i++) openStream(i, "ws");
      const httpCount = Math.floor((MUX_RECEIVE_RESERVATION_BYTES - 8 * MiB) / LIMITS_V1.http_window_bytes);
      for (let i = 0; i < httpCount; i++) openStream(i + 8, "http");
      const before = e.engine.stats;
      if (role === "server") openStream(8 + httpCount, "http");
      else expect(() => openStream(8 + httpCount, "http")).toThrow(MuxStreamError);
      await e.engine.flush();
      expect(e.engine.stats.streams).toBe(8 + httpCount);
      expect(e.engine.stats.reservedBytes).toBe(before.reservedBytes);
      expect(e.engine.stats.reservedBytes).toBeLessThanOrEqual(MUX_RECEIVE_RESERVATION_BYTES);
      if (role === "server") {
        expect(e.http).toHaveLength(httpCount);
        expect(e.sent.some((f) => f.type === FrameType.RESET && f.payload.code === "refused")).toBe(true);
      }
      expect(2 * MUX_RECEIVE_RESERVATION_BYTES + 4 * MiB + MiB + 64 * KiB + MUX_FLIGHT.total).toBeLessThan(32 * MiB);
      expect(e.errors).toEqual([]);
    });
  }
  it("reserves one terminal message beyond the nonterminal outgoing cap", async () => {
    const p = pair();
    const terminal = await socket(p);
    const files = [0, 1, 2, 3].map((i) => p.client.openHttp({ method: "GET", target: `/file/${i}`, headers: [], body: "none" }));
    await p.flush();
    const remote = p.http;
    p.hold.server = true;
    for (const stream of remote) stream.headers(200);
    const writes = remote.slice(0, 3).map((s) => outcome(s.write(new Uint8Array(MiB))));
    expect(p.server.stats.nonterminalQueuedBytes).toBe(3 * MiB);
    const exceeded = outcome(required(remote[3]).write(new Uint8Array(1)));
    expect(required(remote[3]).cancelled).toBe(true);
    terminal.remote.send(new Uint8Array(MiB));
    expect(p.server.stats.queuedBytes).toBe(4 * MiB);
    expect(terminal.remote.cancelled).toBe(false);
    p.server.carrierLost();
    await Promise.all([...writes, exceeded]);
    expect(p.server.stats.queuedBytes).toBe(0);
    expect(files).toHaveLength(4);
  });
  it("enforces OPEN and frame token buckets with deterministic refill", async () => {
    const e = endpoint("server", { onHttp: (stream) => stream.reset("refused") });
    for (let i = 0; i < 64; i++) e.engine.receive(open(i * 2 + 1));
    expect(e.engine.active).toBe(true);
    e.clock.advance(1000 / 32);
    e.engine.receive(open(129));
    expect(e.engine.active).toBe(true);
    e.engine.receive(open(131));
    await e.engine.flush();
    expect(e.errors[0]?.code).toBe("resource_exhausted");
    const f = endpoint();
    for (let i = 0; i < 8192; i++) f.engine.receive(receipt(0n));
    f.clock.advance(1000 / 4096);
    f.engine.receive(receipt(0n));
    expect(f.engine.active).toBe(true);
    f.engine.receive(receipt(0n));
    await f.engine.flush();
    expect(f.errors[0]?.code).toBe("resource_exhausted");
  });
  it("caps control queue and metadata without retaining unbounded empty messages", async () => {
    const e = endpoint();
    for (let i = 0; i < 5000; i++) e.engine.receive(frame({ type: FrameType.PING, flags: 0, stream_id: 0, payload: BigInt(i) }));
    await e.engine.flush();
    expect(e.errors[0]?.code).toBe("resource_exhausted");
    expect(e.engine.stats.controlQueuedBytes).toBe(0);
    const p = pair();
    const { local, remote } = await socket(p);
    expect(p.server.retainMetadata(remote, MiB)).toBe(false);
    await p.flush();
    expect(remote.cancelled).toBe(true);
    expect(local.cancelled).toBe(true);
  });
  it("times out setup at ten seconds using only the injected clock", async () => {
    const clock = new Clock();
    const closed: number[] = [];
    const engine = new MuxEngine({ role: "server", clock, send: async () => undefined, close: (code) => { closed.push(code); }, outboundWireByteLength: (bytes) => bytes.length + 24, routingOverhead: 0, maxWireMessageBytes: 32 * KiB });
    engines.push(engine);
    clock.advance(9999);
    expect(closed).toEqual([]);
    clock.advance(1);
    await engine.flush();
    expect(closed).toEqual([4000]);
  });
  it("rejects unauthenticated or mismatched-device OPEN before application dispatch", async () => {
    for (const authenticated of [false, true]) {
      const e = endpoint("server");
      if (!authenticated) Reflect.set(e.engine, "deviceId", undefined);
      const metadata = decodeFrame(open(1));
      if (metadata.type !== FrameType.HTTP_OPEN) throw new Error("Wrong test frame");
      e.engine.receive(frame({ ...metadata, payload: { ...metadata.payload, device_id: authenticated ? "aaaaaaaaaaaaaaaa" : device } }));
      await e.engine.flush();
      expect(e.http).toHaveLength(0);
      expect(e.errors[0]?.code).toBe("protocol_error");
    }
  });
  it("rejects oversized frames and reserved flags before retaining stream state", async () => {
    for (const bytes of [new Uint8Array(16385), open(1)]) {
      const e = endpoint("server");
      bytes[2] = 128;
      e.engine.receive(bytes);
      await e.engine.flush();
      expect(e.engine.stats.streams).toBe(0);
      expect(e.errors[0]?.code).toBe("protocol_error");
    }
  });
  it("uses the adapter's HTTP route deadline and leaves idle SSE open", async () => {
    const e = endpoint("server", { requestTimeoutMs: (request) => request.target === "/slow" ? 180_000 : 0 });
    e.engine.receive(open(1, "http", "/slow"));
    e.engine.receive(open(3, "http", "/api/machines/events"));
    await e.engine.flush();
    // Liveness is independent of route timeouts: supply matching probes at their deadlines.
    for (let i = 0; i < 9; i++) {
      e.clock.advance(20_000);
      await e.engine.flush();
      const ping = e.sent.filter((f) => f.type === FrameType.PING).at(-1);
      if (ping?.type === FrameType.PING) e.engine.receive(frame({ ...ping, type: FrameType.PONG }));
    }
    expect(required(e.http[0]).cancelled).toBe(true);
    expect(required(e.http[1]).live).toBe(true);
  });
  it("pings after twenty idle seconds and requires a matching PONG within sixty", async () => {
    const e = endpoint("server");
    e.clock.advance(19_999);
    await e.engine.flush();
    expect(e.sent).toHaveLength(0);
    e.clock.advance(1);
    await e.engine.flush();
    const ping = e.sent.find((f) => f.type === FrameType.PING);
    expect(ping?.type).toBe(FrameType.PING);
    if (ping?.type !== FrameType.PING) throw new Error("Missing PING");
    e.engine.receive(frame({ ...ping, type: FrameType.PONG, payload: ping.payload ^ 1n }));
    e.clock.advance(59_999);
    expect(e.closes).toEqual([]);
    e.clock.advance(1);
    await e.engine.flush();
    expect(e.errors[0]?.code).toBe("timeout");
  });
  it("invalidates hidden probes and stale PONGs on wake", async () => {
    const e = endpoint();
    e.engine.ping();
    await e.engine.flush();
    const stale = required(e.sent.find((f) => f.type === FrameType.PING));
    e.engine.setHidden(true);
    e.clock.advance(120_000);
    expect(e.closes).toEqual([]);
    e.engine.setHidden(false);
    await e.engine.flush();
    const fresh = required(e.sent.filter((f) => f.type === FrameType.PING).at(-1));
    expect(fresh.payload).not.toBe(stale.payload);
    if (stale.type !== FrameType.PING || fresh.type !== FrameType.PING) throw new Error("Missing probes");
    e.engine.receive(frame({ ...stale, type: FrameType.PONG }));
    e.clock.advance(59_000);
    e.engine.receive(frame({ ...fresh, type: FrameType.PONG }));
    e.clock.advance(2000);
    expect(e.errors).toEqual([]);
  });
  it("pauses blocked-consumer deadlines while hidden instead of failing on wake", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    remote.onMessage = () => deferred<void>().promise;
    local.send(new Uint8Array(MiB));
    await p.flush();
    local.send("blocked");
    await p.flush();
    p.client.setHidden(true);
    p.clock.advance(40_000);
    await p.flush();
    expect(local.live).toBe(true);
    p.client.setHidden(false);
    await p.flush();
    expect(local.live).toBe(true);
    p.clock.advance(29_000);
    await p.flush();
    expect(local.live).toBe(true);
    p.clock.advance(1000);
    await p.flush();
    expect(local.cancelled).toBe(true);
  });
});

describe("carrier loss never resends", () => {
  it("arbitrary disconnect points suppress every old-generation send and late callback", async () => {
    for (const point of ["before OPEN", "upload", "mutation", "before receipt", "pending sink"] as const) {
      let executions = 0;
      const p = pair({ onHttp: () => { executions++; } });
      const late = deferred<void>();
      const enteredSink = deferred<void>();
      const stream = p.client.openHttp({ method: "POST", target: "/mutation", headers: [], body: "stream" });
      if (point !== "before OPEN") {
        await p.flush();
        required(p.http[0]).accept();
        await p.flush();
      }
      let writing: Promise<unknown> | undefined;
      if (point === "upload" || point === "before receipt") {
        p.intercept((side, f) => { if (side === "client" && f.type === FrameType.HTTP_DATA) p.client.carrierLost(); });
        writing = outcome(stream.write(new Uint8Array(100_000)));
        await p.flush();
      } else if (point === "pending sink") {
        p.intercept((side, f) => {
          if (side === "client" && f.type === FrameType.HTTP_DATA) {
            p.client.carrierLost();
            enteredSink.resolve();
            return late.promise;
          }
        });
        writing = outcome(stream.write(new Uint8Array(100_000)));
        await enteredSink.promise;
      }
      p.client.carrierLost();
      p.server.carrierLost();
      const calls = { ...p.calls };
      late.resolve();
      await p.flush();
      if (writing) await writing;
      p.clock.advance(1_000_000);
      p.client.receive(receipt(U64_MAX));
      p.server.receive(open(999));
      await p.flush();
      expect(p.calls).toEqual(calls);
      expect(executions).toBe(point === "before OPEN" ? 0 : 1);
      expect(p.client.stats.queuedBytes).toBe(0);
      expect(p.server.stats.inboundBytes).toBe(0);
    }
  });
  it("repeated interruptions at every WS fragment boundary never replay input", async () => {
    for (let boundary = 0; boundary <= 65; boundary++) {
      const p = pair({ trace: false });
      const { local, remote } = await socket(p);
      let fragments = 0;
      let delivered = 0;
      remote.onMessage = () => { delivered++; };
      p.intercept((side, f) => {
        if (side === "client" && f.type === FrameType.WS_DATA && ++fragments === boundary) p.client.carrierLost();
      });
      local.send(new Uint8Array(MiB));
      if (boundary === 0) p.client.carrierLost();
      await p.flush();
      const calls = p.calls.client;
      p.client.carrierLost();
      p.clock.advance(60_000);
      await p.flush();
      expect(p.calls.client).toBe(calls);
      expect(delivered).toBeLessThanOrEqual(1);
      expect(local.queuedBytes).toBe(0);
      p.server.carrierLost();
    }
  });
  it("retains received 4008 after loss but never invents an undelivered close cause", async () => {
    for (const delivered of [true, false]) {
      const p = pair();
      const { local, remote } = await socket(p);
      const closed: WsClose[] = [];
      local.onClose = (event) => { closed.push(event); };
      p.hold.server = !delivered;
      remote.close(4008, "terminal output consumer stalled", true);
      await p.flush();
      p.client.carrierLost();
      expect(closed).toHaveLength(1);
      expect(closed[0]?.code).toBe(delivered ? 4008 : 1006);
    }
  });
  it("invalidates late downstream completion and never retries a rejected sink", async () => {
    const p = pair();
    const { local, remote } = await socket(p);
    const entered = deferred<void>();
    const complete = deferred<void>();
    remote.onMessage = () => { entered.resolve(); return complete.promise; };
    local.send("input once");
    await entered.promise;
    p.server.carrierLost();
    const calls = p.calls.server;
    complete.resolve();
    await p.flush();
    expect(p.calls.server).toBe(calls);
    let sends = 0;
    const e = endpoint("client", { send: () => { sends++; return Promise.reject(new Error("Lost after encryption")); } });
    e.engine.openHttp({ method: "POST", target: "/mutation", body: "none", headers: [] });
    await e.engine.flush();
    e.clock.advance(1_000_000);
    await e.engine.flush();
    expect(sends).toBe(1);
    expect(e.closes).toEqual([4000]);
  });
});
