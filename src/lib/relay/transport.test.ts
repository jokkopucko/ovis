import { afterEach, expect, it } from "bun:test";
import { createElement, StrictMode } from "react";
import { act, create } from "react-test-renderer";
import { bounded, deferred, relayConnection, relayDevice, relayFixture, TestClock } from "../../../server/relay/test-helpers.ts";
import type { RelaySessionOptions } from "../../../server/relay/session.ts";
import type { WsStream } from "../../../shared/relay-mux-engine.ts";
import { nativeTransport, setTransport } from "../transport.ts";
import type { WebSocketLike } from "../transport.ts";
import { useResourceUrlState } from "../useResourceUrl.ts";
import type { ResourceUrlState } from "../useResourceUrl.ts";
import { RelayPcOfflineError, RelayUnreachableError } from "./channel.ts";
import { GLOBAL_RELAY, REGIONAL_RELAYS } from "../../../shared/relay-regions.ts";
import type { RelayChannelOptions, RelaySocket } from "./channel.ts";
import type { RelayDevice, RelayDeviceStore } from "./device.ts";
import { DIRECT_BUDGET_MS, isFatalRelayError, openRelayTransport, RECONNECT_PC_ANSWER_MS, RelayWebSocket, SSE_BUFFER_LIMIT } from "./transport.ts";
import { LIMITS_V1, MuxProtocolError } from "../../../shared/relay-mux.ts";
import { RelayResourceTooLargeError } from "./resources.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  setTransport(nativeTransport);
});

async function fixture(options: Partial<RelaySessionOptions> = {}, { relay = "wss://relay.example", unreachable = 0, features, featuresOf, listPlace, listKey = false }: {
  relay?: string; unreachable?: number;
  /** what the PC selected in its answer to HELLO, and the place in its account's list it handed a device it let in */
  features?: readonly string[]; listPlace?: { readonly id: string; readonly seq: number; readonly hash: string };
  /** what the PC selects for each carrier as it comes up, where that changes between carriers (in place of `features`) */
  featuresOf?: () => readonly string[] | undefined;
  /** the device signs in with the key its account's list holds for it */
  listKey?: boolean;
} = {}) {
  const app = relayFixture();
  cleanups.push(() => app.close());
  const device = await relayDevice(app);
  const clock = new TestClock();
  const connections: Awaited<ReturnType<typeof relayConnection>>[] = [];
  const carriers: { open: boolean }[] = [];
  const callbacks: NonNullable<RelayChannelOptions["onClose"]>[] = [];
  const attempts = { count: 0, failures: 0, offline: 0, away: 0, unreachable, refusal: null as Error | null,
    pcAnswerMs: [] as (number | undefined)[], relays: [] as string[], offered: [] as string[],
    /** attempts whose socket stays CONNECTING until aborted or failed through `stuck` (a page frozen mid-connect) */
    hang: 0, stuck: [] as ((error: Error) => void)[],
    /** a hanging attempt's socket the relay took, waiting for the PC (the channel's `assigned`) */
    heldAtRelay: false, held: deferred<void>() };
  const fatal: Error[] = [];
  const offer = { v: 1 as const, server_id: "0123456789abcdef0123456789abcdef",
    server_public_key: "", relay };
  const transport = await openRelayTransport(offer, {
    clock,
    // a session opened with the key the account's signed list holds for this device
    ...(listKey ? { accountListKey: true } : {}),
    onFatal: (error) => fatal.push(error),
    onPcAway: () => { attempts.away++; },
    openChannel: async (channelOffer, config = {}) => {
      attempts.count++;
      attempts.pcAnswerMs.push(config.pcAnswerMs);
      attempts.relays.push(config.carrier ?? channelOffer.relay);
      attempts.offered.push(channelOffer.relay);
      if (attempts.hang > 0) {
        attempts.hang--;
        if (attempts.heldAtRelay) config.onAssigned?.();
        attempts.held.resolve();
        return new Promise<never>((_, reject) => {
          attempts.stuck.push(reject);
          config.signal?.addEventListener("abort", () => reject(new DOMException("Relay connection aborted", "AbortError")), { once: true });
        });
      }
      if (attempts.unreachable > 0) { attempts.unreachable--; throw new RelayUnreachableError(null, true); }
      if (attempts.refusal !== null) { const refusal = attempts.refusal; attempts.refusal = null; throw refusal; }
      if (attempts.failures > 0) { attempts.failures--; throw new TypeError("Network offline"); }
      if (attempts.offline > 0) { attempts.offline--; throw new RelayPcOfflineError(); }
      const connection = await relayConnection(app, options);
      connections.push(connection);
      await connection.auth(device);
      const notify = config.onClose ?? (() => {});
      callbacks.push(notify);
      void connection.closed.then(() => notify(new TypeError("Carrier dropped")));
      const carrier = { open: true };
      carriers.push(carrier);
      return {
        get carrierOpen() { return carrier.open; },
        mux: connection.mux, role: "drive", connectionId: "ef".repeat(16), sessionId: "ab".repeat(16),
        server: (() => { const selected = featuresOf?.() ?? features; return { version: "0.4.20", relayProtocol: 1, ...(selected === undefined ? {} : { features: selected }) }; })(),
        ...(listPlace === undefined ? {} : { listPlace }),
        device: { server_id: offer.server_id, device_id: device.id, private_key: device.keys.privateKey,
          public_spki: device.publicKey, label: "Test", server_public_key: "", relay: offer.relay },
        close: () => connection.stop(),
      };
    },
  });
  cleanups.push(() => transport.close());
  return {
    transport, app, clock, connections, carriers, callbacks, attempts, fatal,
    async drop() {
      const current = connections.at(-1);
      if (!current) throw new Error("No connection");
      current.stop();
      await bounded(current.closed);
    },
  };
}

function event<T extends Event>(source: EventTarget, type: string, select: (event: Event) => T): Promise<T> {
  return bounded(new Promise<T>((resolve) => source.addEventListener(type, (value) => resolve(select(value)), { once: true })));
}
function opened(source: EventTarget): Promise<Event> { return event(source, "open", (value) => value); }
function closed(source: EventTarget): Promise<CloseEvent> {
  return event(source, "close", (value) => { if (!(value instanceof CloseEvent)) throw new Error("Expected close"); return value; });
}
function message(source: EventTarget): Promise<MessageEvent> {
  return event(source, "message", (value) => { if (!(value instanceof MessageEvent)) throw new Error("Expected message"); return value; });
}

async function saturated() {
  const requested: string[] = [];
  const f = await fixture({
    onWs: (stream) => stream.accept(),
    dispatch: async (request) => {
      requested.push(new URL(request.url).pathname);
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new Uint8Array([1])); },
      }));
    },
  });
  const sockets = Array.from({ length: 8 }, () => f.transport.openSocket("/ws"));
  await Promise.all(sockets.map(opened));
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.transport.fetch(`/api/held/${i}`)));
  return { ...f, requested, responses };
}

it("says whether the PC lets its account's devices in by the list, and the place it handed a device it let in", async () => {
  const place = { id: "5c".repeat(32), seq: 2, hash: "ab".repeat(32) };
  for (const [features, listPlace, follows] of [[["account", "account-list-1"], place, true], [["account"], undefined, false], [undefined, undefined, false]] as const) {
    const { transport } = await fixture({}, { ...(features === undefined ? {} : { features }), ...(listPlace === undefined ? {} : { listPlace }) });
    expect([transport.followsList, transport.listPlace]).toEqual([follows, listPlace]);
  }
});

it("tells whoever listens for the route the features of the carrier that just came up, not those of the one before", async () => {
  let selected: readonly string[] = ["account"];
  const f = await fixture({}, { featuresOf: () => selected });
  expect(f.transport.followsList).toBe(false);
  const seen: boolean[] = [];
  f.transport.onRouteChange(() => { if (f.transport.route !== undefined) seen.push(f.transport.followsList); });
  // the PC pins its account's list between two carriers: the listener of the second one hears it
  selected = ["account", "account-list-1"];
  await f.drop();
  await f.transport.connect();
  expect(seen).toEqual([true]);
  // and the other way round
  selected = ["account"];
  await f.drop();
  await f.transport.connect();
  expect(seen).toEqual([true, false]);
});

it("queues HTTP behind eight WS and twelve HTTP streams until a receive reservation is released", async () => {
  const f = await saturated();
  const waiting = f.transport.fetch("/api/waiting");
  expect(f.requested).toHaveLength(12);
  await f.responses[0]?.body?.cancel();
  const response = await bounded(waiting);
  expect(response.status).toBe(200);
  expect(f.requested).toHaveLength(13);
  expect(f.requested.at(-1)).toBe("/api/waiting");
});

it("fails queued HTTP at its deadline without sending the request", async () => {
  const f = await saturated();
  const waiting = f.transport.fetch("/api/timed-out").catch((error: unknown) => error);
  f.clock.advance(30_000);
  expect(await waiting).toBeInstanceOf(TypeError);
  expect(f.requested).toHaveLength(12);
});

it("bounds queued HTTP and removes cancelled requests before admitting the next one", async () => {
  const f = await saturated();
  const abort = new AbortController();
  const cancelled = f.transport.fetch("/api/cancelled", { signal: abort.signal }).catch((error: unknown) => error);
  const waiting = Array.from({ length: 63 }, (_, i) => f.transport.fetch(`/api/queued/${i}`).catch((error: unknown) => error));
  await expect(f.transport.fetch("/api/overflow")).rejects.toBeInstanceOf(TypeError);
  abort.abort();
  expect(await cancelled).toMatchObject({ name: "AbortError" });
  await f.responses[0]?.body?.cancel();
  expect(await bounded(waiting[0] ?? Promise.reject(new Error("Missing queued request")))).toBeInstanceOf(Response);
  expect(f.requested.at(-1)).toBe("/api/queued/0");
  f.transport.close();
  expect((await Promise.all(waiting.slice(1))).every((error) => error instanceof TypeError)).toBe(true);
});

it("rejects queued HTTP on carrier loss rather than replaying it after reconnect", async () => {
  const f = await saturated();
  const waiting = f.transport.fetch("/api/do-not-replay", { method: "POST", body: "once" }).catch((error: unknown) => error);
  await f.drop();
  expect(await bounded(waiting)).toBeInstanceOf(TypeError);
  await f.transport.connect();
  expect(f.requested).toHaveLength(12);
});

it("fetches JSON and preserves Range, ETag and conditional responses through real Noise and RelaySession", async () => {
  const f = await fixture({ dispatch: async (request) => {
    if (request.headers.get("if-none-match") === '"v1"') return new Response(null, { status: 304, headers: { etag: '"v1"' } });
    if (request.headers.get("range") === "bytes=2-4") return new Response("234", {
      status: 206, headers: { "content-range": "bytes 2-4/10", etag: '"v1"' },
    });
    return Response.json({ ok: true });
  } });
  const json = await f.transport.fetch("/api/json", { credentials: "include", mode: "no-cors" });
  const range = await f.transport.fetch("/api/file", { headers: { range: "bytes=2-4" } });
  const unchanged = await f.transport.fetch("/api/file", { headers: { "if-none-match": '"v1"' } });
  expect(json).toBeInstanceOf(Response);
  expect(await json.json()).toEqual({ ok: true });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 2-4/10");
  expect(range.headers.get("etag")).toBe('"v1"');
  expect(await range.text()).toBe("234");
  expect(unchanged.status).toBe(304);
  expect(unchanged.body).toBeNull();
});

it("resets the server request when an AbortSignal interrupts a streaming response", async () => {
  const aborted = deferred<void>();
  const f = await fixture({ dispatch: async (request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("first")); } }));
  } });
  const abort = new AbortController();
  const response = await f.transport.fetch("/api/stream", { signal: abort.signal });
  const reader = response.body?.getReader();
  expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("first");
  abort.abort();
  await bounded(aborted.promise);
  await expect(reader?.read()).rejects.toMatchObject({ name: "AbortError" });
});

it("sends a request body where the browser has no Request.body, as Firefox", async () => {
  const native = globalThis.Request;
  globalThis.Request = class extends native {
    override get body() { return this.url.startsWith("https://relay.ovis.invalid/") ? undefined as unknown as null : super.body; }
  };
  cleanups.push(() => { globalThis.Request = native; });
  const f = await fixture({ dispatch: async (request) => new Response(await request.text()) });
  const response = await f.transport.fetch("/api/echo", { method: "POST", headers: { "content-type": "application/json" }, body: '{"a":1}' });
  expect(await response.text()).toBe('{"a":1}');
});

/** A browser without Request.body (Firefox) for the page's requests: bodies given to them and their reads are counted, and reads wait for `hold`. */
function firefoxRequests(hold: Promise<void> = Promise.resolve()) {
  const native = globalThis.Request;
  const reads = { count: 0, bodies: 0 };
  const page = (url: string): boolean => url.startsWith("https://relay.ovis.invalid/");
  globalThis.Request = class extends native {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(input, init);
      if (page(this.url) && init?.body != null) reads.bodies++;
    }
    override get body() { return page(this.url) ? undefined as unknown as null : super.body; }
    override async arrayBuffer(): Promise<ArrayBuffer> { if (page(this.url)) { reads.count++; await hold; } return super.arrayBuffer(); }
    override async blob(): Promise<Blob> { if (page(this.url)) { reads.count++; await hold; } return super.blob(); }
  };
  cleanups.push(() => { globalThis.Request = native; });
  return reads;
}

it("never sends a Firefox request on a carrier that reconnected while its body was read", async () => {
  const held = deferred<void>();
  const reads = firefoxRequests(held.promise);
  const requested: string[] = [];
  const f = await fixture({ dispatch: async (request) => {
    requested.push(new URL(request.url).pathname);
    return Response.json({ ok: true });
  } });
  const answer = f.transport.fetch("/api/pane/prompt/answer", { method: "POST", body: '{"custom_text":"typed answer"}' })
    .catch((error: unknown) => error);
  expect(reads.count).toBe(1);
  await f.drop();
  await f.transport.connect();
  expect(f.connections).toHaveLength(2);
  held.resolve();
  expect(await bounded(answer)).toBeInstanceOf(TypeError);
  expect((await f.transport.fetch("/api/after")).status).toBe(200);
  expect(requested).toEqual(["/api/after"]);
});

it("refuses a Firefox request body without reading it when no carrier is up or it is over the request limit", async () => {
  const reads = firefoxRequests();
  let requests = 0;
  const f = await fixture({ dispatch: async () => { requests++; return new Response(null); } });
  const big = new Blob([new Uint8Array(LIMITS_V1.max_request_body_bytes + 1)]);
  await expect(f.transport.fetch("/api/upload", { method: "POST", body: big })).rejects.toBeInstanceOf(TypeError);
  const text = "\u00e9".repeat(LIMITS_V1.max_request_body_bytes / 2 + 1);
  await expect(f.transport.fetch("/api/upload", { method: "POST", body: text })).rejects.toBeInstanceOf(TypeError);
  const form = new FormData();
  form.append("audio", new File([new Uint8Array(LIMITS_V1.max_request_body_bytes / 2)], "voice.webm"));
  form.append("note", "x".repeat(LIMITS_V1.max_request_body_bytes / 2));
  await expect(f.transport.fetch("/api/upload", { method: "POST", body: form })).rejects.toBeInstanceOf(TypeError);
  await f.drop();
  await expect(f.transport.fetch("/api/upload", { method: "POST", body: "small" })).rejects.toBeInstanceOf(TypeError);
  expect(reads).toEqual({ count: 0, bodies: 0 });
  expect(requests).toBe(0);
});

it("rejects an upload on carrier loss with TypeError and aborts the server handler", async () => {
  const reading = deferred<void>();
  const aborted = deferred<void>();
  const f = await fixture({ dispatch: async (request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    const reader = request.body?.getReader();
    await reader?.read();
    reading.resolve();
    await aborted.promise;
    return new Response(null);
  } });
  const request = f.transport.fetch("/api/upload", { method: "POST", body: new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
  }) });
  const rejection = request.then(() => null, (error: unknown) => error);
  await bounded(reading.promise);
  await f.drop();
  expect(await rejection).toBeInstanceOf(TypeError);
  await bounded(aborted.promise);
  console.log("DROP: upload fetch rejected TypeError; server handler signal aborted; no retry");
});

async function trace(socket: WebSocketLike, code: number, drop: () => void): Promise<string[]> {
  const events: string[] = [];
  const done = deferred<string[]>();
  socket.addEventListener("open", () => { events.push(`open:${socket.readyState}`); socket.send("hello"); });
  socket.addEventListener("message", (event) => {
    events.push(`message:${event.data}`);
    if (code === 1006) drop();
    else socket.close(code, "done");
  });
  socket.addEventListener("error", () => events.push("error"));
  socket.addEventListener("close", (event) => { events.push(`close:${event.code}:${socket.readyState}`); done.resolve(events); });
  return bounded(done.promise);
}

for (const code of [1000, 4008, 1006]) {
  it(`matches native WebSocket open/message/error/close ordering for ${code}`, async () => {
    let nativeDrop = () => {};
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { return server.upgrade(request) ? undefined : new Response(null, { status: 400 }); },
      websocket: {
        open(socket) { nativeDrop = () => socket.terminate(); },
        message(socket, data) { socket.send(data); },
      },
    });
    cleanups.push(() => server.stop(true));
    const f = await fixture({ onWs: (stream) => { stream.accept(); stream.onMessage = (data) => { stream.send(data); }; } });
    const native = await trace(new WebSocket(`ws://127.0.0.1:${server.port}`), code, () => nativeDrop());
    const relay = await trace(f.transport.openSocket("/ws"), code, () => f.connections.at(-1)?.stop());
    // Bun's native TCP termination has no error event; browsers report one for abnormal loss.
    expect(relay.filter((entry) => entry !== "error")).toEqual(native.filter((entry) => entry !== "error"));
    if (code === 1006) expect(relay.slice(-2)).toEqual(["error", "close:1006:3"]);
    console.log(`WS ${code}: native=${native.join(",")} relay=${relay.join(",")}`);
  });
}

it("preserves server initiated 4008 and listener removal without reopening the virtual socket", async () => {
  const server = deferred<WsStream>();
  const f = await fixture({ onWs: (stream) => { stream.accept(); server.resolve(stream); } });
  const socket = f.transport.openSocket("/ws");
  const removed = () => { throw new Error("Removed listener ran"); };
  socket.addEventListener("open", removed);
  socket.removeEventListener("open", removed);
  await opened(socket);
  const close = closed(socket);
  (await bounded(server.promise)).close(4008, "output stalled", true);
  expect(await close).toMatchObject({ code: 4008, reason: "output stalled", wasClean: false });
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(f.connections).toHaveLength(1);
});

it("keeps a relay WS closing once its carrier is gone, even while a new carrier is current", async () => {
  const f = await fixture({ onWs: (stream) => { stream.accept(); } });
  const socket = f.transport.openSocket("/ws");
  await opened(socket);
  f.callbacks.at(-1)!(new TypeError("Carrier dropped"));
  expect(socket.readyState).toBe(socket.CLOSING);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.connections).toHaveLength(2);
  expect(socket.readyState).toBe(socket.CLOSING);
});

it("reads a relay WS as closing once its carrier is, sends nothing into it, and ends that carrier for a new one", async () => {
  const received: string[] = [];
  const f = await fixture({ onWs: (stream) => { stream.accept(); stream.onMessage = (data) => { received.push(String(data)); }; } });
  const socket = f.transport.openSocket("/ws");
  await opened(socket);
  const close = closed(socket);
  f.carriers.at(-1)!.open = false;
  expect(socket.readyState).toBe(socket.CLOSING);
  socket.send("typed while closing");
  expect((await bounded(close, 2000)).code).toBe(1006);
  expect(received).toEqual([]);
  await bounded(f.connections.at(-1)!.closed);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.connections).toHaveLength(2);
  expect(socket.readyState).toBe(socket.CLOSED);
  const next = f.transport.openSocket("/ws");
  await opened(next);
  expect(next.readyState).toBe(next.OPEN);
});

for (const initial of ["connecting", "open"]) {
  it(`keeps discarded send bytes through closing and closed after closing from ${initial}`, async () => {
    const received: string[] = [];
    const f = await fixture({ onWs: (stream) => {
      stream.accept();
      stream.onMessage = (data) => { received.push(String(data)); };
    } });
    const socket = f.transport.openSocket("/ws");
    if (initial === "open") await opened(socket);
    const atClose = deferred<number>();
    socket.addEventListener("close", () => atClose.resolve(socket.bufferedAmount), { once: true });
    // When close is followed immediately by a discarded send, as in Chromium.
    socket.close(1000);
    socket.send("abc");
    expect(socket.readyState).toBe(socket.CLOSING);
    expect(socket.bufferedAmount).toBe(3);
    expect(await bounded(atClose.promise)).toBe(3);
    expect(socket.readyState).toBe(socket.CLOSED);
    socket.send(new Blob(["def"]));
    expect(socket.bufferedAmount).toBe(6);
    expect(received).toEqual([]);
  });
}

it("dispatches property handlers at their native listener position and copies binary sends", async () => {
  const f = await fixture({ onWs: (stream) => {
    stream.accept();
    stream.onMessage = (data) => { stream.send(data); };
  } });
  const socket = f.transport.openSocket("/ws");
  const order: string[] = [];
  socket.addEventListener("open", () => order.push("before"));
  socket.onopen = () => order.push("old");
  socket.addEventListener("open", () => order.push("after"));
  socket.onopen = () => order.push("property");
  await opened(socket);
  expect(order).toEqual(["before", "property", "after"]);
  const data = new Uint8Array([8, 9, 10]);
  const echoed = message(socket);
  socket.binaryType = "arraybuffer";
  socket.send(data.subarray(1));
  data.fill(0);
  const received = (await echoed).data;
  expect(received).toBeInstanceOf(ArrayBuffer);
  expect([...new Uint8Array(received)]).toEqual([9, 10]);
});

it("fails a websocket whose unsent messages pass the send queue bound, keeping every unsent byte counted", async () => {
  const f = await fixture({ onWs: (stream) => stream.accept() });
  const socket = f.transport.openSocket("/ws");
  await opened(socket);
  const events: string[] = [];
  socket.onerror = () => events.push("error");
  const end = closed(socket);
  const chunk = new Uint8Array(1024 * 1024);
  socket.send(chunk);
  socket.send(chunk);
  await socket["outgoing"];
  const held = socket.bufferedAmount;
  expect(held).toBeGreaterThanOrEqual(chunk.length);
  for (let index = 0; index < 5; index++) socket.send(chunk);
  // Then the socket fails at once, as a browser's does when its send buffer is full, and nothing unsent is forgotten
  expect(socket.readyState).toBe(socket.CLOSING);
  expect(socket.bufferedAmount).toBe(held + 5 * chunk.length);
  expect(await end).toMatchObject({ code: 1006, wasClean: false });
  expect(events).toEqual(["error"]);
  expect(socket.bufferedAmount).toBe(held + 5 * chunk.length);
});

it("fails a websocket sent more small messages at once than it may hold", async () => {
  const f = await fixture({ onWs: (stream) => stream.accept() });
  const socket = f.transport.openSocket("/ws");
  await opened(socket);
  const end = closed(socket);
  for (let index = 0; index < 20_000; index++) socket.send("");
  expect(socket.readyState).toBe(socket.CLOSING);
  expect(await end).toMatchObject({ code: 1006, wasClean: false });
});

it("fails a refused websocket handshake with error before abnormal close", async () => {
  const f = await fixture();
  const socket = f.transport.openSocket("/ws");
  const events: string[] = [];
  socket.onerror = () => events.push("error");
  socket.onopen = () => events.push("open");
  const end = closed(socket);
  const result = await end;
  expect(events).toEqual(["error"]);
  expect(result).toMatchObject({ code: 1006, wasClean: false });
});

it("never replays an asynchronously queued send after reconnect and ignores old generation callbacks", async () => {
  const received: string[] = [];
  const f = await fixture({ onWs: (stream) => {
    stream.accept();
    stream.onMessage = (data) => { received.push(String(data)); stream.send(data); };
  } });
  const socket = f.transport.openSocket("/ws");
  await opened(socket);
  const release = deferred<ArrayBuffer>();
  class HeldBlob extends Blob { override arrayBuffer() { return release.promise; } }
  socket.send(new HeldBlob(["stale"]));
  expect(socket.bufferedAmount).toBe(5);
  const oldClosed = closed(socket);
  await f.drop();
  await oldClosed;
  expect(socket.bufferedAmount).toBe(5);
  await f.transport.connect();
  f.callbacks[0]?.(new TypeError("Late old close"));
  release.resolve(new TextEncoder().encode("stale").buffer);
  await socket["outgoing"];
  expect(socket.bufferedAmount).toBe(5);
  const replacement = f.transport.openSocket("/ws");
  await opened(replacement);
  const echoed = message(replacement);
  replacement.send("fresh");
  await echoed;
  expect(received).toEqual(["fresh"]);
  expect(socket.readyState).toBe(socket.CLOSED);
  expect(f.connections).toHaveLength(2);
});

it("fails every stream across repeated drops without HTTP retries or websocket replay", async () => {
  let requests = 0;
  const f = await fixture({ dispatch: async () => { requests++; return Response.json({ requests }); },
    onWs: (stream) => stream.accept() });
  for (let index = 0; index < 3; index++) {
    const socket = f.transport.openSocket("/ws");
    await opened(socket);
    const close = closed(socket);
    const response = await f.transport.fetch("/api/count");
    await response.json();
    await f.drop();
    expect((await close).code).toBe(1006);
    await expect(f.transport.fetch("/api/offline")).rejects.toBeInstanceOf(TypeError);
    await f.transport.connect();
  }
  expect(requests).toBe(3);
});

it("reconnects only the carrier with backoff from one second capped at thirty seconds", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  f.attempts.failures = 7;
  await f.drop();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([delay]);
    f.clock.advance(delay);
    await expect(f.transport.connect()).rejects.toBeInstanceOf(TypeError);
  }
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([30000]);
  f.clock.advance(30000);
  await f.transport.connect();
  expect(f.attempts.count).toBe(9);
  expect(await (await f.transport.fetch("/api/new")).json()).toEqual({ ok: true });
  expect(f.clock.tasks.size).toBe(0);
  await f.drop();
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
});

it("tries again a second after each attempt the relay held waiting for a PC that is away, so a restarted PC is reached at once", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  f.attempts.offline = 6;
  await f.drop();
  for (let attempt = 0; attempt < 6; attempt++) {
    expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
    f.clock.advance(1000);
    await expect(f.transport.connect()).rejects.toBeInstanceOf(RelayPcOfflineError);
  }
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.attempts.count).toBe(8);
  expect(f.attempts.pcAnswerMs).toEqual([undefined, ...Array<number>(7).fill(RECONNECT_PC_ANSWER_MS)]);
  expect(await (await f.transport.fetch("/api/back")).json()).toEqual({ ok: true });
  expect(f.fatal).toEqual([]);
});

it("says what a reconnect has found so far: the relay waiting for a PC that is away, or no relay reached", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  expect(f.transport.unreached).toBeUndefined();
  f.attempts.failures = 1;
  await f.drop();
  f.clock.advance(1000);
  await expect(f.transport.connect()).rejects.toBeInstanceOf(TypeError);
  expect(f.transport.unreached).toBe("relay");
  f.attempts.hang = 1;
  f.attempts.heldAtRelay = true;
  f.clock.advance(2000);
  const held = f.transport.connect();
  await bounded(f.attempts.held.promise);
  expect(f.transport.unreached).toBe("pc");
  f.attempts.stuck[0]!(new RelayPcOfflineError());
  await expect(held).rejects.toBeInstanceOf(RelayPcOfflineError);
  expect(f.transport.unreached).toBe("pc");
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.transport.unreached).toBeUndefined();
});

it("tells the shell each time a reconnect finds nobody for the PC at the relay, and only then, and goes on reconnecting", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  f.attempts.failures = 1;
  f.attempts.offline = 2;
  await f.drop();
  f.clock.advance(1000);
  await expect(f.transport.connect()).rejects.toBeInstanceOf(TypeError);
  expect(f.attempts.away).toBe(0);
  for (const [delay, away] of [[2000, 1], [1000, 2]] as const) {
    f.clock.advance(delay);
    await expect(f.transport.connect()).rejects.toBeInstanceOf(RelayPcOfflineError);
    expect(f.attempts.away).toBe(away);
  }
  f.clock.advance(1000);
  await f.transport.connect();
  expect(await (await f.transport.fetch("/api/back")).json()).toEqual({ ok: true });
  expect([f.attempts.away, f.fatal]).toEqual([2, []]);
});

it("keeps the growing pause after such waits while the page is hidden", async () => {
  const page = Object.assign(new EventTarget(), { visibilityState: "hidden" });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: page });
  cleanups.push(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document"); });
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  f.attempts.offline = 2;
  await f.drop();
  for (const delay of [1000, 2000]) {
    expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([delay]);
    f.clock.advance(delay);
    await expect(f.transport.connect()).rejects.toBeInstanceOf(RelayPcOfflineError);
  }
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([4000]);
});

it("stops reconnecting once the PC refuses the device for good, and tells the shell", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  const revoked = new MuxProtocolError("auth_revoked", "Device revoked");
  f.attempts.refusal = revoked;
  await f.drop();
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await expect(f.transport.connect()).rejects.toBe(revoked);
  expect(f.fatal).toEqual([revoked]);
  expect(f.clock.tasks.size).toBe(0);
  expect(f.attempts.count).toBe(2);
  await expect(f.transport.fetch("/api/after")).rejects.toBeInstanceOf(TypeError);
  f.clock.advance(60_000);
  expect(f.attempts.count).toBe(2);
});

it("a session opened with the list key stops reconnecting when the PC refuses the account's way in, as one opened with the sign-in's key does (M60)", async () => {
  for (const code of ["not_listed", "admission"]) {
    const refusal = Object.assign(new MuxProtocolError("protocol_error", code), { code });
    const f = await fixture({ dispatch: async () => Response.json({ ok: true }) }, { listKey: true });
    f.attempts.refusal = refusal;
    await f.drop();
    f.clock.advance(1000);
    await expect(f.transport.connect()).rejects.toBe(refusal);
    expect([f.fatal, f.clock.tasks.size]).toEqual([[refusal], 0]);
    // a pairing's own session reads the same answer as a carrier that may come back, and tries again
    const own = await fixture({ dispatch: async () => Response.json({ ok: true }) });
    own.attempts.refusal = Object.assign(new MuxProtocolError("protocol_error", code), { code });
    await own.drop();
    own.clock.advance(1000);
    await own.transport.connect().catch(() => undefined);
    expect(own.fatal).toEqual([]);
  }
});

it("tells a refusal that cannot change from a carrier that may come back", () => {
  for (const code of ["auth_revoked", "auth_failed", "unsupported_version", "unsupported_extension", "unsupported_transport"] as const) {
    expect(isFatalRelayError(new MuxProtocolError(code, code))).toBe(true);
  }
  // the PC answered and refused: asking again by itself would only ask the account service again
  for (const code of ["account_unreachable", "account_readd_required"]) {
    expect(isFatalRelayError(Object.assign(new MuxProtocolError("protocol_error", code), { code }))).toBe(true);
  }
  for (const code of ["auth_changed", "timeout", "internal_error", "protocol_error", "resource_exhausted", "flow_control_error"] as const) {
    expect(isFatalRelayError(new MuxProtocolError(code, code))).toBe(false);
  }
  expect(isFatalRelayError(new TypeError("Network offline"))).toBe(false);
});

it("signs in again on renew, so a session proves the key the saved pairing holds now", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  const first = f.connections.at(-1);
  if (!first) throw new Error("Missing relay connection");
  f.transport.renew();
  await bounded(first.closed);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.attempts.count).toBe(2);
  expect(f.fatal).toEqual([]);
  expect((await f.transport.fetch("/api/health")).status).toBe(200);
});

it("settles a renew once the carrier that replaces it is up, not on one already on its way", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  await f.drop();
  f.clock.advance(1000);
  const reconnecting = f.transport.connect();
  let up = false;
  const renewed = f.transport.renew().then(() => { up = true; });
  await reconnecting;
  await bounded(f.connections.at(-1)!.closed);
  expect(up).toBe(false);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  await bounded(renewed);
  expect(up).toBe(true);
  expect(f.attempts.count).toBe(3);
  expect((await f.transport.fetch("/api/health")).status).toBe(200);
});

it("reconnects after an authorization change without telling the shell to forget the PC", async () => {
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) });
  const connection = f.connections.at(-1);
  if (!connection) throw new Error("Missing relay connection");
  f.callbacks.at(-1)?.(new MuxProtocolError("auth_changed", "Role changed"));
  connection.stop();
  await bounded(connection.closed);
  expect(f.fatal).toEqual([]);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.attempts.count).toBe(2);
  expect((await f.transport.fetch("/api/health")).status).toBe(200);
  expect(f.fatal).toEqual([]);
});

it("reconnects on online and visible-page events and removes wake listeners on close", async () => {
  const browser = new EventTarget();
  const page = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    addEventListener: browser.addEventListener.bind(browser),
    removeEventListener: browser.removeEventListener.bind(browser),
    document: page,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  cleanups.push(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  const f = await fixture();
  await f.drop();
  browser.dispatchEvent(new Event("online"));
  await f.transport.connect();
  expect(f.connections).toHaveLength(2);
  await f.drop();
  page.visibilityState = "hidden";
  page.dispatchEvent(new Event("visibilitychange"));
  expect(f.attempts.count).toBe(2);
  page.visibilityState = "visible";
  page.dispatchEvent(new Event("visibilitychange"));
  await f.transport.connect();
  expect(f.connections).toHaveLength(3);
  expect(f.clock.tasks.size).toBe(0);
  f.transport.close();
  browser.dispatchEvent(new Event("online"));
  page.dispatchEvent(new Event("visibilitychange"));
  expect(f.attempts.count).toBe(3);
});

it("takes its carrier as gone when the page comes back from the back/forward cache, though it still reads open, and connects again", async () => {
  const browser = new EventTarget();
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ addEventListener: browser.addEventListener.bind(browser), removeEventListener: browser.removeEventListener.bind(browser) })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, value });
  }
  cleanups.push(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  page("visible");
  const pageshow = (persisted: boolean): Event => Object.assign(new Event("pageshow"), { persisted });
  const f = await fixture();
  // a page loaded fresh says nothing of its carrier
  browser.dispatchEvent(pageshow(false));
  expect([f.attempts.count, f.carriers[0]!.open]).toEqual([1, true]);
  // restored whole: the browser (or the phone app, at the navigation away) ended the socket under it with no close event
  browser.dispatchEvent(pageshow(true));
  await bounded(f.connections[0]!.closed);
  expect([...f.clock.tasks.values()].map((task) => task.at - f.clock.now())).toEqual([1000]);
  f.clock.advance(1000);
  await f.transport.connect();
  expect(f.connections).toHaveLength(2);
  expect(f.fatal).toEqual([]);
  f.transport.close();
  browser.dispatchEvent(pageshow(true));
  expect(f.attempts.count).toBe(2);
});

function page(visibilityState: "visible" | "hidden") {
  const target = Object.assign(new EventTarget(), { visibilityState });
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: target });
  cleanups.push(() => { if (descriptor) Object.defineProperty(globalThis, "document", descriptor); else Reflect.deleteProperty(globalThis, "document"); });
  const turn = (state: "visible" | "hidden"): void => { target.visibilityState = state; target.dispatchEvent(new Event("visibilitychange")); };
  return { target, hide: () => turn("hidden"), show: () => turn("visible") };
}

it("drops an attempt that began while the page was hidden and connects again at once when it is shown", async () => {
  const shown = page("visible");
  const regional = REGIONAL_RELAYS[0]!;
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) }, { relay: regional });
  shown.hide();
  f.attempts.hang = 1;
  await f.drop();
  // the backoff retry fires in the background, and the page is frozen with its socket still CONNECTING
  f.clock.advance(1000);
  expect(f.attempts.relays).toEqual([regional, regional]);
  const resumedAt = f.clock.now();
  shown.show();
  expect(f.attempts.relays).toEqual([regional, regional, regional]);
  expect(f.clock.now()).toBe(resumedAt);
  await f.transport.connect();
  expect((await f.transport.fetch("/api/health")).status).toBe(200);
  expect(f.attempts.relays).not.toContain(GLOBAL_RELAY);
  expect([f.clock.tasks.size, f.fatal]).toEqual([0, []]);
});

it("does not fall back to the other relay when an attempt that began before the page hid fails", async () => {
  const shown = page("visible");
  const regional = REGIONAL_RELAYS[0]!;
  const f = await fixture({ dispatch: async () => Response.json({ ok: true }) }, { relay: regional });
  f.attempts.hang = 1;
  await f.drop();
  f.clock.advance(1000);
  shown.hide();
  // back on screen, the stale socket's error runs before the page's visibilitychange
  shown.target.visibilityState = "visible";
  f.attempts.stuck[0]!(new RelayUnreachableError(null, true));
  await expect(f.transport.connect()).rejects.toBeInstanceOf(RelayUnreachableError);
  expect(f.attempts.relays).toEqual([regional, regional]);
  shown.show();
  expect(f.attempts.relays).toEqual([regional, regional, regional]);
  await f.transport.connect();
  expect((await f.transport.fetch("/api/health")).status).toBe(200);
  expect([f.clock.tasks.size, f.fatal]).toEqual([0, []]);
});

it("carries the pairing code into the attempt that replaces a hidden first pairing, whose outcome the first callers wait for", async () => {
  const shown = page("visible");
  const offered: (string | undefined)[] = [];
  const refusal = new MuxProtocolError("auth_failed", "Pairing refused");
  const pairing = openRelayTransport({ v: 1, server_id: "a".repeat(32), server_public_key: "key", code: "123456", relay: "wss://relay.example" }, {
    openChannel: (channelOffer, config = {}) => {
      offered.push(channelOffer.code);
      if (offered.length > 1) return Promise.reject(refusal);
      // the first socket is still connecting when the app goes to the background
      return new Promise<never>((_, reject) => config.signal?.addEventListener("abort", () => reject(new DOMException("Relay connection aborted", "AbortError")), { once: true }));
    },
  });
  shown.hide();
  shown.show();
  await expect(pairing).rejects.toBe(refusal);
  expect(offered).toEqual(["123456", "123456"]);
});

/** First pairing through the real channel, each read of the device store held until the test answers it, and sockets that stay connecting. */
function heldPairing(signal?: AbortSignal) {
  const reads: ReturnType<typeof deferred<RelayDevice | undefined>>[] = [];
  const sockets: { closed: number }[] = [];
  const socketOpened = deferred<void>();
  const store: RelayDeviceStore = {
    get: () => { const read = deferred<RelayDevice | undefined>(); reads.push(read); return read.promise; },
    update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {},
  };
  const socket = (): RelaySocket => {
    const state = { closed: 0 };
    sockets.push(state);
    socketOpened.resolve();
    return { binaryType: "arraybuffer", readyState: 0, send: () => {}, close: () => { state.closed++; }, onmessage: null, onclose: null, onerror: null };
  };
  const pairing = openRelayTransport({ v: 1, server_id: "a".repeat(32), server_public_key: "key", code: "123456", relay: "wss://relay.example" }, { store, socket, ...(signal ? { signal } : {}) });
  return { pairing, reads, sockets, socketOpened: socketOpened.promise };
}

it("hands the callers of a dropped first pairing to its replacement at once, so its failure is theirs while the old read still hangs", async () => {
  const shown = page("visible");
  const { pairing, reads } = heldPairing();
  shown.hide();
  shown.show();
  expect(reads).toHaveLength(2);
  const refusal = new Error("Storage refused");
  reads[1]!.reject(refusal);
  expect(await bounded(pairing.then(() => null, (error: unknown) => error), 2_000)).toBe(refusal);
  reads[0]!.resolve(undefined);
});

it("settles a first pairing cancelled while its replacement still reads the device store", async () => {
  const shown = page("visible");
  const controller = new AbortController();
  const { pairing, reads, sockets, socketOpened } = heldPairing(controller.signal);
  reads[0]!.resolve(undefined);
  await bounded(socketOpened, 2_000);
  shown.hide();
  shown.show();
  expect(reads).toHaveLength(2);
  controller.abort();
  await bounded(pairing.then(() => undefined, () => undefined), 2_000);
  expect(sockets.map((socket) => socket.closed)).toEqual([1]);
  reads[1]!.resolve(undefined);
});

it("settles a native connection with the relay's failure while the saved direct route is still being read", async () => {
  const shown = page("visible");
  let reads = 0;
  const store: RelayDeviceStore = {
    get: () => { reads++; return new Promise<never>(() => {}); },
    update: async (_id, change) => change(undefined), list: async () => [], remove: async () => {},
  };
  const unreachable = new RelayUnreachableError(null, true);
  const connecting = openRelayTransport({ v: 1, server_id: "a".repeat(32), server_public_key: "key", relay: "wss://relay.example" }, {
    store, directSocket: () => { throw new Error("No direct route was read"); }, openChannel: () => Promise.reject(unreachable),
  });
  shown.hide();
  shown.show();
  expect(reads).toBe(2);
  expect(await bounded(connecting.then(() => null, (error: unknown) => error), DIRECT_BUDGET_MS + 1_000)).toBe(unreachable);
});

function referenceSse(text: string) {
  const events: { type: string; data: string; id: string }[] = [];
  let id = "";
  for (const block of text.replace(/^\uFEFF/, "").replace(/\r\n|\r/g, "\n").split("\n\n").slice(0, -1)) {
    let type = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      const match = /^([^:]*)(?:: ?(.*))?$/.exec(line);
      if (match?.[1] === "data") data.push(match[2] ?? "");
      if (match?.[1] === "event") type = match[2] || "message";
      if (match?.[1] === "id" && !match[2]?.includes("\0")) id = match[2] ?? "";
    }
    if (data.length) events.push({ type, data: data.join("\n"), id });
  }
  return events;
}

for (const width of [1, 2, 7, 31]) {
  it(`parses SSE like a reference parser across ${width}-byte arbitrary boundaries`, async () => {
    const text = "\uFEFF:comment\r\ngarbage\r\nid: first\r\ndata: 한글\r\ndata: next\r\n\r\nevent: custom\rdata: second\r\rid: bad\0id\ndata:\n\ndata: unfinished";
    const bytes = new TextEncoder().encode(text);
    const expected = referenceSse(text);
    const f = await fixture({ dispatch: async () => new Response(new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < bytes.length; offset += width) controller.enqueue(bytes.slice(offset, offset + width));
        controller.close();
      },
    }), { headers: { "content-type": "text/event-stream" } }) });
    const source = f.transport.openEventSource("/api/machines/events");
    const received: typeof expected = [];
    const receive = (value: Event) => {
      if (value instanceof MessageEvent) received.push({ type: value.type, data: value.data, id: value.lastEventId });
    };
    source.addEventListener("message", receive);
    source.addEventListener("custom", receive);
    const ended = event(source, "error", (value) => value);
    await ended;
    expect(received).toEqual(expected);
    expect(source.readyState).toBe(2);
    expect(f.connections).toHaveLength(1);
  });
}

it("closes and resets SSE when an unfinished event exceeds its buffer bound", async () => {
  const aborted = deferred<void>();
  const f = await fixture({ dispatch: async (request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("data:" + "x".repeat(SSE_BUFFER_LIMIT + 1))); },
    }), { headers: { "content-type": "text/event-stream" } });
  } });
  const source = f.transport.openEventSource("/api/machines/events");
  const error = event(source, "error", (value) => value);
  await error;
  expect(source.readyState).toBe(2);
  await bounded(aborted.promise);
});

it("fails streaming HTTP bodies and SSE together on carrier loss without reopening either", async () => {
  let requests = 0;
  const f = await fixture({ dispatch: async (request) => {
    requests++;
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(request.url.endsWith("/events") ? "data: ready\n\n" : "chunk"));
    } }), { headers: { "content-type": request.url.endsWith("/events") ? "text/event-stream" : "text/plain" } });
  } });
  const response = await f.transport.fetch("/api/body");
  const reader = response.body?.getReader();
  await reader?.read();
  const source = f.transport.openEventSource("/api/events");
  await message(source);
  const error = event(source, "error", (value) => value);
  await f.drop();
  await expect(reader?.read()).rejects.toBeInstanceOf(TypeError);
  await error;
  expect(source.readyState).toBe(2);
  expect(requests).toBe(2);
});

it("cancels a real mux response over the blob limit with the typed too-large error", async () => {
  const aborted = deferred<void>();
  const f = await fixture({ dispatch: async (request) => {
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(16384)); } }),
      { headers: { "content-length": String(70 * 1024 * 1024) } });
  } });
  await expect(f.transport.resourceUrl("/api/fs/file?path=large.pdf")).rejects.toBeInstanceOf(RelayResourceTooLargeError);
  await bounded(aborted.promise);
});

it("loads a real file larger than the mux session buffer as a bounded blob", async () => {
  const f = await fixture();
  const path = join(f.app.stateDir, "large.bin");
  writeFileSync(path, new Uint8Array(40 * 1024 * 1024));
  const url = await bounded(f.transport.resourceUrl(`/api/fs/file?path=${encodeURIComponent(path)}`), 30_000);
  try { expect((await (await fetch(url)).blob()).size).toBe(40 * 1024 * 1024); }
  finally { URL.revokeObjectURL(url); }
}, 30_000);

it("returns a blob resource fetched over the relay and stops a closed SSE without an error event", async () => {
  const aborted = deferred<void>();
  const f = await fixture({ dispatch: async (request) => {
    if (request.url.includes("/fs/file")) return new Response("resource", { headers: { "content-type": "text/plain" } });
    request.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return new Response(new ReadableStream(), { headers: { "content-type": "text/event-stream" } });
  } });
  const url = await f.transport.resourceUrl("/api/fs/file?path=resource");
  cleanups.push(() => URL.revokeObjectURL(url));
  expect(url.startsWith("blob:")).toBe(true);
  expect(await (await fetch(url)).text()).toBe("resource");
  const source = f.transport.openEventSource("/api/events");
  let errors = 0;
  source.onerror = () => { errors++; };
  await opened(source);
  source.close();
  await bounded(aborted.promise);
  expect(source.readyState).toBe(2);
  expect(errors).toBe(0);
});

it("exposes resource failures as hook state without an unhandled promise rejection", async () => {
  const f = await fixture({ dispatch: async () => new Response(null, { status: 404 }) });
  setTransport(f.transport);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  cleanups.push(() => {
    if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  const result = deferred<ResourceUrlState>();
  function Probe() {
    const state = useResourceUrlState("/api/fs/file?path=missing");
    if (state.error) result.resolve(state);
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(Probe)); });
  await act(async () => { await bounded(result.promise); });
  // Then the caller can render the failure; Bun's test runner also fails unhandled rejections.
  expect(await result.promise).toMatchObject({ url: null, error: expect.any(TypeError) });
  await act(async () => renderer?.unmount());
});

it("throws on send while connecting and validates close arguments synchronously", () => {
  const socket = new RelayWebSocket(() => { throw new TypeError("Offline"); });
  // When callers violate the browser socket contract.
  // Then errors are synchronous, not swallowed by an asynchronous send queue.
  expect(() => socket.send("early")).toThrow(DOMException);
  expect(() => socket.close(1006)).toThrow(DOMException);
  expect(() => socket.close(1000, "x".repeat(124))).toThrow(DOMException);
  socket.close();
});

it("keeps a StrictMode resource usable and revokes each owned blob on cleanup", async () => {
  // Given a resource hook whose effects will be replayed by React StrictMode.
  const f = await fixture({ dispatch: async () => new Response("image") });
  setTransport(f.transport);
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  const revoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  URL.revokeObjectURL = (url) => { revoked.push(url); revoke(url); };
  cleanups.push(() => {
    URL.revokeObjectURL = revoke;
    if (descriptor) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", descriptor);
    else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  });
  const loaded = deferred<string>();
  function Probe() {
    const state = useResourceUrlState("/api/fs/file?path=image");
    if (state.url) loaded.resolve(state.url);
    return null;
  }
  let renderer: ReturnType<typeof create> | undefined;
  await act(async () => { renderer = create(createElement(StrictMode, null, createElement(Probe))); });
  await act(async () => { await bounded(loaded.promise); });
  const url = await loaded.promise;
  expect(await (await fetch(url)).text()).toBe("image");
  expect(revoked).not.toContain(url);
  await act(async () => renderer?.unmount());
  expect(revoked).toContain(url);
  await expect(fetch(url)).rejects.toBeInstanceOf(TypeError);
});

it("falls back to the global relay when a regional one cannot be reached, and reconnects through it", async () => {
  const f = await fixture({}, { relay: REGIONAL_RELAYS[0]!, unreachable: 1 });
  expect(f.attempts.relays).toEqual([REGIONAL_RELAYS[0]!, GLOBAL_RELAY]);
  expect(f.connections).toHaveLength(1);
  expect(f.attempts.offered).toEqual([REGIONAL_RELAYS[0]!, REGIONAL_RELAYS[0]!]);
  await f.drop();
  await f.transport.connect();
  expect(f.attempts.relays).toEqual([REGIONAL_RELAYS[0]!, GLOBAL_RELAY, GLOBAL_RELAY]);
});

it("never falls back from a relay that is not one of Ovis's regional relays", async () => {
  await expect(fixture({}, { relay: "wss://relay.example", unreachable: 1 })).rejects.toBeInstanceOf(RelayUnreachableError);
});

